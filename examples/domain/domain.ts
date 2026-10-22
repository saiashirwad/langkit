import { type Check, check, type Diagnostic, fail, render, type Result } from "langkit";
import { type Analysis, type Definition, highlight, unanalyzed } from "langkit/analysis";
import { loadModules, type ModuleGraph, type ModuleOptions, type ModuleSource } from "langkit/modules";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Machine,
  type Module,
  scalars,
  showEvent,
  showState,
  showTypeDecl,
  type TypeDecl,
  type TypeKey,
  typeKey,
} from "./domain-model.ts";
import { type Declaration, type File, imports, type Name, parse, tokens } from "./domain-syntax.ts";
import { elaborateMachine, type MachineDeclaration } from "./machine.ts";
import { attempt, type Binder, error, facts, reserved, type Scope, type Type } from "./scope.ts";
import { definitionKind, elaborateTypes, type TypeDeclaration, typeNames } from "./types.ts";

const language = { extension: "domain", imports } as const;

const usedTypes = (declaration: Declaration): readonly Name[] => {
  switch (declaration.kind) {
    case "brand":
      return [];
    case "union":
      return declaration.members.flatMap(({ fields }) => (fields ?? []).flatMap(({ type }) => typeNames(type)));
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

/** Everything linked so far: what each module exports, and the IR behind every type key. */
type Linked = {
  readonly exports: Map<string, ReadonlyMap<string, Binder>>;
  readonly universe: Map<TypeKey, TypeDecl>;
};

/**
 * Binds imports, then every top-level name, before anything is elaborated, so declaration order never matters.
 * Imports and declarations share one namespace.
 */
const bind = (linked: Linked, source: ModuleSource, file: File) =>
  check(function*() {
    const { uri } = source;
    const top = new Map<string, Binder>();
    const own = new Map<string, Binder>();
    const types: (readonly [TypeDeclaration, Binder])[] = [];
    const machines: (readonly [MachineDeclaration, Binder])[] = [];
    const claim = (name: Name): Check<void> =>
      check(function*() {
        if (reserved.type.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
        }
        if (top.has(name.name) || Object.hasOwn(scalars, name.name)) {
          return yield* error(name, `Duplicate declaration: ${name.name}`);
        }
      });
    for (const directive of file.imports) {
      const edge = source.imports.find(({ span }) => span.start === directive.span.start)!;
      const exported = linked.exports.get(edge.uri)!;
      for (const name of directive.names) {
        yield* attempt(check(function*() {
          const binder = exported.get(name.name);
          if (!binder) return yield* error(name, `Unknown export: ${directive.path} has no ${name.name}`);
          yield* claim(name);
          yield* facts.reference(binder, name.span);
          top.set(name.name, binder);
        }));
      }
    }
    for (const declaration of file.declarations) {
      const { name } = declaration;
      yield* attempt(check(function*() {
        yield* claim(name);
        const binder: Binder = {
          kind: declaration.kind === "machine" ? "machine" : "type",
          id: Symbol(name.name),
          key: typeKey(uri, name.name),
          uri,
          name,
        };
        top.set(name.name, binder);
        own.set(name.name, binder);
        if (declaration.kind === "machine") machines.push([declaration, binder]);
        else types.push([declaration, binder]);
      }));
    }
    return { top, own, types, machines };
  });

const elaborate = (linked: Linked, source: ModuleSource, file: File): Check<Module> =>
  check(function*() {
    const { uri } = source;
    const bound = yield* bind(linked, source, file);
    const { top } = bound;
    const types = yield* elaborateTypes({ uri, top, universe: linked.universe }, bound.types);
    for (const type of types) linked.universe.set(type.key, type);
    const scope: Scope = { uri, top, universe: linked.universe };

    const machines: Machine[] = [];
    for (const [declaration, binder] of bound.machines) {
      const machine = yield* attempt(elaborateMachine(scope, declaration, binder));
      if (machine) machines.push(machine);
    }

    for (const use of [...file.imports.flatMap(({ names }) => names), ...file.declarations.flatMap(usedTypes)]) {
      const binder = top.get(use.name);
      const type = binder && linked.universe.get(binder.key);
      if (type) yield* facts.typed(showTypeDecl(type), use.span);
    }
    linked.exports.set(uri, bound.own);
    return { uri, types, machines, universe: linked.universe };
  });

/** What another file can jump to: every name a module declares, with its URI. */
const definitionsOf = ({ uri, types, machines }: Module): readonly Definition<Type>[] => [
  ...types.map((type) => ({
    id: type.id,
    name: type.name.name,
    span: type.name.span,
    kind: definitionKind[type.kind],
    type: showTypeDecl(type),
    uri,
  })),
  ...machines.flatMap(({ id, name, events, states }) => [
    { id, name: name.name, span: name.span, kind: "namespace" as const, type: `machine ${name.name}`, uri },
    ...events.map((event) => ({
      id: event.id,
      name: event.name.name,
      span: event.name.span,
      kind: "method" as const,
      type: showEvent(event),
      uri,
    })),
    ...states.map((state) => ({
      id: state.symbol,
      name: state.name.name,
      span: state.name.span,
      kind: "class" as const,
      type: showState(state),
      uri,
    })),
  ]),
];

type Linking = { readonly root: Module; readonly foreign: readonly Definition<Type>[]; };

/**
 * Every module in graph order, dependencies first, each under `.inDocument(uri)` so a dependency's error carries
 * its origin and `routeDiagnostic` moves it to the root's import line. Dependencies run under `facts.ignore`.
 */
const link = (graph: ModuleGraph): Check<Linking> =>
  check(function*() {
    const linked: Linked = { exports: new Map(), universe: new Map() };
    const foreign: Definition<Type>[] = [];
    for (const source of graph.modules) {
      const parsed = parse(source.original);
      if (!parsed.success) {
        const [first] = parsed.errors;
        return yield* fail(first.message).at(first.span).inDocument(source.uri);
      }
      const module = elaborate(linked, source, parsed.value).inDocument(source.uri);
      if (source.uri === graph.root) return { root: yield* module, foreign };
      foreign.push(...definitionsOf(yield* facts.ignore(module)));
    }
    throw new Error("Module graph has no root");
  });

const routed = (graph: ModuleGraph, errors: readonly [Diagnostic, ...Diagnostic[]]): Result<never> => ({
  success: false,
  errors: [graph.routeDiagnostic(errors[0]), ...errors.slice(1).map((error) => graph.routeDiagnostic(error))],
});

/** The compile path, what the host and the loader see: syntax, names, types, data flow and the machine audit. */
export const checkSource = (source: string, options: ModuleOptions = {}): Result<Module> => {
  const graph = loadModules(source, options, language);
  if (!graph.success) return graph;
  const { result } = facts.collect(link(graph.value));
  return result.success ? { success: true, value: result.value.root } : routed(graph.value, result.errors);
};

export const analyze = (source: string, options: ModuleOptions = {}): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const graph = loadModules(source, options, language);
  if (!graph.success) return unanalyzed(graph.errors, lexical);
  let foreign: readonly Definition<Type>[] = [];
  const { analysis } = facts.collect(link(graph.value).map((linking) => (foreign = linking.foreign)), lexical);
  const referenced = new Set(analysis.references.map(({ id }) => id));
  return {
    ...analysis,
    diagnostics: analysis.diagnostics.map((error) => graph.value.routeDiagnostic(error)),
    definitions: [...analysis.definitions, ...foreign.filter(({ id }) => referenced.has(id))],
    sources: graph.value.sources,
    dependencyUris: graph.value.dependencyUris,
  };
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
