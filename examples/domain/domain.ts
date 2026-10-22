import { type Check, check, type Diagnostic, fail, type Result } from "langkit";
import { type Analysis, type Definition, highlight, unanalyzed } from "langkit/analysis";
import { loadModules, type ModuleGraph, type ModuleOptions, type ModuleSource } from "langkit/modules";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Machine,
  type Module,
  scalars,
  showEvent,
  showState,
  showTypeDecl,
  type System,
  type TypeDecl,
  type TypeKey,
  typeKey,
} from "./domain-model.ts";
import { type Declaration, type File, imports, type Name, parse, tokens } from "./domain-syntax.ts";
import { type Outcome, outcome } from "./explore.ts";
import { elaborateMachine, type MachineDeclaration } from "./machine.ts";
import { key, lower } from "./product.ts";
import { attempt, type Binder, error, facts, reserved, type Scope, type Type } from "./scope.ts";
import { elaborateSystem, type SystemDeclaration } from "./system.ts";
import { checkLimit, diagnose, fails, renderTrace, tooLarge } from "./trace.ts";
import { definitionKind, elaborateTypes, type TypeDeclaration, typeNames } from "./types.ts";

const language = { extension: "domain", imports } as const;

const usedTypes = (declaration: Declaration): readonly Name[] => {
  switch (declaration.kind) {
    case "brand":
    case "system":
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
  readonly machines: Map<TypeKey, Machine>;
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
    const systems: (readonly [SystemDeclaration, Binder])[] = [];
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
          if (binder.kind === "system") {
            return yield* error(name, `${name.name} is a system; systems do not compose yet`);
          }
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
          kind: declaration.kind === "machine" || declaration.kind === "system" ? declaration.kind : "type",
          id: Symbol(name.name),
          key: typeKey(uri, name.name),
          uri,
          name,
        };
        top.set(name.name, binder);
        own.set(name.name, binder);
        switch (declaration.kind) {
          case "machine":
            machines.push([declaration, binder]);
            return;
          case "system":
            systems.push([declaration, binder]);
            return;
          default:
            types.push([declaration, binder]);
        }
      }));
    }
    return { top, own, types, machines, systems };
  });

const elaborate = (linked: Linked, source: ModuleSource, file: File): Check<Module> =>
  check(function*() {
    const { uri } = source;
    const bound = yield* bind(linked, source, file);
    const { top } = bound;
    const scope: Scope = { uri, top, universe: linked.universe, machines: linked.machines };
    const types = yield* elaborateTypes(scope, bound.types);
    for (const type of types) linked.universe.set(type.key, type);

    const machines: Machine[] = [];
    for (const [declaration, binder] of bound.machines) {
      const machine = yield* attempt(elaborateMachine(scope, declaration, binder));
      if (machine) {
        machines.push(machine);
        linked.machines.set(binder.key, machine);
      }
    }
    const systems: System[] = [];
    for (const [declaration, binder] of bound.systems) {
      const system = yield* attempt(elaborateSystem(scope, declaration, binder));
      if (system) systems.push(system);
    }

    for (const use of [...file.imports.flatMap(({ names }) => names), ...file.declarations.flatMap(usedTypes)]) {
      const binder = top.get(use.name);
      const type = binder && linked.universe.get(binder.key);
      if (type) yield* facts.typed(showTypeDecl(type), use.span);
    }
    linked.exports.set(uri, bound.own);
    return { uri, types, machines, systems, universe: linked.universe };
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
    const linked: Linked = { exports: new Map(), universe: new Map(), machines: new Map() };
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

/**
 * The editor's exploration budget, in reachable states. On a synthetic worst case 21k states explore in 6ms and
 * one `~>` takes 26ms; every other edit reuses the cached outcome.
 */
export const editorBudget = 20_000;

/** Outcomes by budget and `key(product)`, most recent last; small, since only open files' systems land here. */
const outcomes = new Map<string, Outcome>();
const remembered = 32;

export type Verified = {
  readonly system: System;
  readonly outcome: Outcome;
  readonly diagnostics: readonly Diagnostic[];
};

/**
 * The verify path: lower each system, reuse or compute its outcome, then diagnose against the current IR. Every
 * finding is an error, as every other diagnostic is.
 */
export const verify = (module: Module, budget: number): readonly Verified[] =>
  module.systems.map((system) => {
    const product = lower(system);
    const id = `${budget}:${key(product)}`;
    const result = outcomes.get(id) ?? outcome(product, budget);
    outcomes.delete(id);
    outcomes.set(id, result);
    if (outcomes.size > remembered) outcomes.delete(outcomes.keys().next().value!);
    const diagnostics = result.kind === "too large"
      ? [tooLarge(system, result.limit)]
      : result.findings.map((finding) => diagnose(system, product, finding, result.states));
    return { system, outcome: result, diagnostics };
  });

const transitions = (machine: Machine): number => machine.states.reduce((count, { on }) => count + on.length, 0);

const summary = ({ system, outcome }: Verified): string =>
  outcome.kind === "too large"
    ? `${system.name.name}: more than ${outcome.limit} states, not checked`
    : `${system.name.name}: ${outcome.states} states, ${outcome.transitions} transitions; ${
      system.properties.map(({ name }, index) => `${name.name} ${fails(outcome.findings, index) ? "fails" : "holds"}`)
        .join(", ")
    }`;

if (import.meta.main) {
  const file = process.argv[2]
    ? pathToFileURL(resolve(process.argv[2]))
    : new URL("./shop.domain", import.meta.url);
  const read = (uri: string): string | undefined => {
    try {
      return readFileSync(new URL(uri), "utf8");
    } catch {
      return undefined;
    }
  };
  const result = checkSource(read(file.href) ?? "", { uri: file.href });
  const errors = result.success ? [] : result.errors;
  for (const error of errors) console.error(renderTrace(error, read, file.href));
  const verified = result.success ? verify(result.value, checkLimit) : [];
  for (const { diagnostics } of verified) {
    for (const error of diagnostics) console.error(renderTrace(error, read, file.href));
  }
  for (const machine of result.success && !verified.length ? result.value.machines : []) {
    console.log(`${machine.name.name}: ${machine.states.length} states, ${transitions(machine)} transitions`);
  }
  for (const value of verified) console.log(summary(value));
  if (errors.length || verified.some(({ diagnostics }) => diagnostics.length)) process.exitCode = 1;
}
