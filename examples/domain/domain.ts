import { type Check, check, render, type Result, run } from "langkit";
import { type Analysis, highlight, unanalyzed } from "langkit/analysis";
import type { ModuleOptions } from "langkit/modules";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Machine,
  type Module,
  scalars,
  showTypeDecl,
  type TypeDecl,
  type TypeKey,
  typeKey,
} from "./domain-model.ts";
import { type Declaration, type Name, parse, tokens } from "./domain-syntax.ts";
import { elaborateMachine, type MachineDeclaration } from "./machine.ts";
import { attempt, type Binder, error, facts, reserved, type Scope } from "./scope.ts";
import { elaborateTypes, type TypeDeclaration, typeNames } from "./types.ts";

const usedTypes = (declaration: Declaration): readonly Name[] => {
  switch (declaration.kind) {
    case "brand":
    case "enum":
      return [];
    case "record":
      return declaration.fields.flatMap(({ type }) => typeNames(type));
    case "machine":
      return declaration.items.flatMap((item) =>
        item.kind === "event"
          ? item.payload.flatMap(({ type }) => typeNames(type))
          : item.entries.flatMap((entry) => entry.kind === "spread" ? [entry.record] : typeNames(entry.field.type))
      );
  }
};

/** Binds every top-level name before anything is elaborated, so declaration order never matters. */
const bind = (uri: string, declarations: readonly Declaration[]) =>
  check(function*() {
    const top = new Map<string, Binder>();
    const types: (readonly [TypeDeclaration, Binder])[] = [];
    const machines: (readonly [MachineDeclaration, Binder])[] = [];
    for (const declaration of declarations) {
      const { name } = declaration;
      yield* attempt(check(function*() {
        if (reserved.type.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
        }
        if (top.has(name.name) || Object.hasOwn(scalars, name.name)) {
          return yield* error(name, `Duplicate declaration: ${name.name}`);
        }
        const binder: Binder = {
          kind: declaration.kind === "machine" ? "machine" : "type",
          id: Symbol(name.name),
          key: typeKey(uri, name.name),
          uri,
          name,
        };
        top.set(name.name, binder);
        if (declaration.kind === "machine") machines.push([declaration, binder]);
        else types.push([declaration, binder]);
      }));
    }
    return { top, types, machines };
  });

const elaborate = (uri: string, declarations: readonly Declaration[]): Check<Module> =>
  check(function*() {
    const bound = yield* bind(uri, declarations);
    const { top } = bound;
    const universe = new Map<TypeKey, TypeDecl>();
    const types = yield* elaborateTypes({ uri, top, universe }, bound.types);
    for (const type of types) universe.set(type.key, type);
    const scope: Scope = { uri, top, universe };

    const machines: Machine[] = [];
    for (const [declaration, binder] of bound.machines) {
      const machine = yield* attempt(elaborateMachine(scope, declaration, binder));
      if (machine) machines.push(machine);
    }

    for (const use of declarations.flatMap(usedTypes)) {
      const binder = top.get(use.name);
      const type = binder && universe.get(binder.key);
      if (type) yield* facts.typed(showTypeDecl(type), use.span);
    }
    return { uri, types, machines, universe };
  });

const rootUri = (options: ModuleOptions): string => options.uri ?? pathToFileURL(resolve("input.domain")).href;

/** The compile path, what the host and the loader see: syntax, names, types, data flow and the machine audit. */
export const checkSource = (source: string, options: ModuleOptions = {}): Result<Module> => {
  const parsed = parse(source);
  return parsed.success ? run(elaborate(rootUri(options), parsed.value)) : parsed;
};

export const analyze = (source: string, options: ModuleOptions = {}): Analysis<string> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) return unanalyzed(parsed.errors, lexical);
  return facts.collect(elaborate(rootUri(options), parsed.value), lexical).analysis;
};

const summary = ({ name, states }: Machine): string =>
  `${name.name}: ${states.length} states, ${states.reduce((count, { on }) => count + on.length, 0)} transitions`;

if (import.meta.main) {
  const file = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL("./checkout.domain", import.meta.url);
  const source = readFileSync(file, "utf8");
  const result = checkSource(source, { uri: file.href });
  if (result.success) { for (const machine of result.value.machines) console.log(summary(machine)); }
  else {
    const path = relative(process.cwd(), fileURLToPath(file));
    for (const error of result.errors) console.error(`${path} ${render(error, source)}`);
    process.exitCode = 1;
  }
}
