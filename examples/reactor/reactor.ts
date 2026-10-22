import { type Check, check, render, type Result } from "langkit";
import { type Analysis, highlight, unanalyzed } from "langkit/analysis";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type DataType, type TypeDecl, type TypeKey, typeKey } from "../data/data-model.ts";
import {
  attempt,
  type Binder,
  claim,
  type Dialect,
  elaborateTypes,
  error,
  facts,
  type Scope,
  type Type,
  type TypeDeclaration,
  typescript,
} from "../data/data-types.ts";
import { elaborateMachine, hover, type MachineDeclaration } from "./machine.ts";
import type { Machine, Module } from "./reactor-model.ts";
import { lowerDeclaration, parse, tokens } from "./reactor-syntax.ts";
import type * as G from "./reactor.grammar";
import { constructors } from "./values.ts";

export const dialect: Dialect = { reserved: typescript, variants: "parens" };

const fieldsOf = ({ body }: G.DeclarationType): readonly G.Field[] =>
  body.kind === "record" ? body.fields : body.members.flatMap(({ payload }) => payload?.fields ?? []);

/** The declarations a type reaches through its fields, as a path from `from`, if it reaches `to`. */
const path = (universe: ReadonlyMap<TypeKey, TypeDecl>, from: TypeDecl, to: TypeDecl): readonly TypeDecl[] => {
  const seen = new Set<TypeDecl>();
  const visit = (type: DataType, trail: readonly TypeDecl[]): readonly TypeDecl[] => {
    switch (type.kind) {
      case "scalar":
        return [];
      case "list":
        return visit(type.element, trail);
      case "optional":
        return visit(type.inner, trail);
      case "named": {
        const declaration = universe.get(type.key)!;
        if (declaration === to) return trail;
        if (seen.has(declaration)) return [];
        seen.add(declaration);
        return walk(declaration, [...trail, declaration]);
      }
    }
  };
  const walk = (declaration: TypeDecl, trail: readonly TypeDecl[]): readonly TypeDecl[] => {
    const fields = declaration.kind === "record"
      ? declaration.fields
      : declaration.kind === "tagged"
      ? declaration.variants.flatMap((variant) => variant.fields)
      : [];
    for (const { type } of fields) {
      const found = visit(type, trail);
      if (found.length) return found;
    }
    return [];
  };
  return walk(from, [from]);
};

/** A model checker enumerates reactor state, so no type may contain itself, even through a list. */
const finite = (universe: ReadonlyMap<TypeKey, TypeDecl>, types: readonly TypeDecl[]): Check<void> =>
  check(function*() {
    const reported = new Set<TypeDecl>();
    for (const type of types) {
      if (reported.has(type)) continue;
      const cycle = path(universe, type, type);
      if (!cycle.length) continue;
      for (const member of cycle) reported.add(member);
      const through = cycle.length > 1 ? `, through ${cycle.slice(1).map(({ name }) => name.name).join(", ")}` : "";
      yield* attempt(error(type.name, `Reactor state must be finite: ${type.name.name} contains itself${through}`));
    }
  });

const elaborate = (uri: string, file: G.File): Check<Module> =>
  check(function*() {
    const top = new Map<string, Binder<"machine">>();
    const declared: (readonly [G.DeclarationType, Binder<"machine">])[] = [];
    const machines: (readonly [MachineDeclaration, Binder<"machine">])[] = [];
    for (const declaration of file.declarations) {
      const { name } = declaration;
      yield* attempt(check(function*() {
        yield* claim({ top, dialect }, name);
        const kind = declaration.kind === "machine" ? "machine" : "type";
        const binder: Binder<"machine"> = { kind, id: Symbol(name.name), key: typeKey(uri, name.name), uri, name };
        top.set(name.name, binder);
        if (declaration.kind === "machine") machines.push([declaration, binder]);
        else declared.push([declaration, binder]);
      }));
    }
    const universe = new Map<TypeKey, TypeDecl>();
    const scope: Scope<"machine"> = { uri, top, universe, dialect };
    const lowered = declared.map(([declaration, binder]): readonly [TypeDeclaration, Binder] => [
      lowerDeclaration(declaration),
      binder,
    ]);
    const types = yield* elaborateTypes(scope, lowered);
    for (const type of types) universe.set(type.key, type);
    for (const [declaration] of declared) {
      for (const { type } of fieldsOf(declaration)) yield* hover(scope, type);
    }
    yield* finite(universe, types);
    const known = constructors(universe);
    const elaborated = [];
    for (const [declaration, binder] of machines) {
      const machine = yield* attempt(elaborateMachine(scope, known, declaration, binder));
      if (machine) elaborated.push(machine);
    }
    return { uri, types, machines: elaborated, universe };
  });

export type Options = { readonly uri?: string; };

const uriOf = (options: Options): string => options.uri ?? "file:///main.reactor";

/** The compile path: syntax, names, types, patterns, list bounds and causality. Every finding is an error. */
export const checkSource = (source: string, options: Options = {}): Result<Module> => {
  const parsed = parse(source);
  if (!parsed.success) return parsed;
  return facts.collect(elaborate(uriOf(options), parsed.value)).result;
};

/** The LSP entry: facts survive errors, so hover and links stay up while one row is broken. */
export const analyze = (source: string, options: Options = {}): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) return unanalyzed(parsed.errors, lexical);
  return facts.collect(elaborate(uriOf(options), parsed.value), lexical).analysis;
};

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const summary = ({ name, inputs, nodes, properties }: Machine): string => {
  const cells = nodes.filter(({ kind }) => kind === "cell").length;
  const counts = [
    count(inputs.length, "input"),
    count(cells, "cell"),
    count(nodes.length - cells, "signal"),
    count(properties.length, "property", "properties"),
  ];
  return `${name.name}: ${counts.join(", ")} (properties are not model checked yet)`;
};

if (import.meta.main) {
  const file = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("./player.reactor", import.meta.url);
  const path = relative(process.cwd(), fileURLToPath(file));
  const source = readFileSync(file, "utf8");
  const result = checkSource(source, { uri: file.href });
  if (result.success) { for (const machine of result.value.machines) console.log(summary(machine)); }
  else {
    for (const error of result.errors) console.error(`${path} ${render(error, source)}`);
    process.exitCode = 1;
  }
}
