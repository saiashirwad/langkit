import { type Check, check, fail, pure, render, type Result, run, type Span } from "langkit";
import { type Analysis, create, highlight, unanalyzed } from "langkit/analysis";
import { readFileSync } from "node:fs";
import { audit, type Finding } from "./graph.ts";
import {
  assignable,
  type DataType,
  type Enum,
  type Event,
  type Field,
  type Fill,
  isScalar,
  type Machine,
  type Record as Shape,
  scalars,
  showEnum,
  showEvent,
  showRecord,
  showState,
  showTransition,
  showType,
  type State,
  type StateId,
  stateId,
  type Transition,
} from "./machine-model.ts";
import {
  type Declaration,
  type Entry,
  type Field as Written,
  type Name,
  type On,
  parse,
  tokens,
  type TypeExpr,
} from "./machine-syntax.ts";

export type Type = string;

export const show = (type: Type): string => type;

const facts = create<Type>();

const error = (at: { readonly span: Span; }, message: string): Check<never> => fail(message).at(at.span);

const attempt = <A>(body: Check<A>): Check<A | undefined> => body.recover(pure(undefined));

/**
 * Names TypeScript or the runtime value cannot carry. Checked here, not in the host, so the guest LSP shows them:
 * a .machine file exists to be imported, so "TypeScript cannot represent X" is a language rule.
 */
const reserved = {
  /** `then` makes every value a thenable `await` hangs on; `toJSON` would replace the snapshot. */
  event: new Set(["then", "toJSON", "constructor", "toString", "valueOf", "__proto__"]),
  /** `state` is the discriminant; `__proto__` would reset the value's prototype in Object.assign. */
  field: new Set(["state", "__proto__"]),
  /** Members of the projected namespace besides the states. */
  state: new Set(["Final"]),
  type: new Set([
    "any",
    "bigint",
    "boolean",
    "class",
    "const",
    "delete",
    "enum",
    "export",
    "function",
    "import",
    "interface",
    "never",
    "new",
    "null",
    "number",
    "object",
    "package",
    "private",
    "protected",
    "public",
    "static",
    "string",
    "symbol",
    "undefined",
    "unknown",
    "void",
    "yield",
  ]),
} as const;

type Of<K extends Declaration["kind"]> = Extract<Declaration, { readonly kind: K; }>;

type Bound<K extends Declaration["kind"]> = { readonly declaration: Of<K>; readonly id: symbol; };

type BoundState = Bound<"state"> & { readonly index: StateId; };

type Scope = {
  readonly machine: Bound<"machine"> | undefined;
  readonly enums: ReadonlyMap<string, Enum>;
  readonly records: ReadonlyMap<string, Bound<"record">>;
  readonly events: ReadonlyMap<string, Bound<"event">>;
  readonly states: ReadonlyMap<string, BoundState>;
  /** Records with their fields resolved, so a state can splice one. Empty until the record pass is done. */
  readonly shapes: ReadonlyMap<string, Shape>;
};

/**
 * Pass 1. Bind every declaration name. Types, states and the machine share one namespace (they all become
 * TypeScript types); events have their own (they become methods).
 */
const declare = (declarations: readonly Declaration[]): Check<Scope> =>
  check(function*() {
    const taken = new Set<string>(Object.keys(scalars));
    const machines: Bound<"machine">[] = [];
    const enums = new Map<string, Enum>();
    const records = new Map<string, Bound<"record">>();
    const events = new Map<string, Bound<"event">>();
    const states = new Map<string, BoundState>();

    const claim = (name: Name): Check<void> =>
      check(function*() {
        if (reserved.type.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
        }
        if (taken.has(name.name)) return yield* error(name, `Duplicate declaration: ${name.name}`);
        taken.add(name.name);
      });

    for (const declaration of declarations) {
      const { name } = declaration;
      const id = Symbol(name.name);
      yield* attempt(check(function*() {
        switch (declaration.kind) {
          case "machine":
            if (machines.length) return yield* error(name, "A .machine file declares one machine");
            yield* claim(name);
            machines.push({ declaration, id });
            return yield* facts.define({ id, name: name.name, type: `machine ${name.name}` }, name.span, "namespace");
          case "enum": {
            yield* claim(name);
            const members: Name[] = [];
            for (const member of declaration.members) {
              if (members.some((seen) => seen.name === member.name)) {
                yield* attempt(error(member, `Duplicate member: ${name.name}.${member.name}`));
                continue;
              }
              members.push(member);
              yield* facts.define(
                { id: Symbol(member.name), name: member.name, type: name.name },
                member.span,
                "enumMember",
              );
            }
            const value: Enum = { id, name, members };
            enums.set(name.name, value);
            return yield* facts.define({ id, name: name.name, type: showEnum(value) }, name.span, "enum");
          }
          case "record":
            yield* claim(name);
            records.set(name.name, { declaration, id });
            return;
          case "event":
            if (reserved.event.has(name.name)) {
              yield* attempt(error(name, `TypeScript cannot represent ${name.name}, an event name`));
            }
            if (events.has(name.name)) return yield* error(name, `Duplicate event: ${name.name}`);
            events.set(name.name, { declaration, id });
            return;
          case "state":
            if (reserved.state.has(name.name)) {
              yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a state name`));
            }
            yield* claim(name);
            states.set(name.name, { declaration, id, index: stateId(states.size) });
            return;
        }
      }));
    }
    return { machine: machines[0], enums, records, events, states, shapes: new Map() };
  });

/** `Missing` -> `Unknown type: Missing`; `String??` -> `A type is optional at most once`. References the type name. */
const resolveType = (scope: Scope, type: TypeExpr): Check<DataType> =>
  check<DataType>(function*() {
    switch (type.kind) {
      case "named": {
        const { name } = type.name;
        if (isScalar(name)) return { kind: "scalar", name };
        const enumeration = scope.enums.get(name);
        if (enumeration) {
          yield* facts.reference(enumeration, type.name.span);
          return { kind: "enum", name };
        }
        const record = scope.records.get(name);
        if (record) {
          yield* facts.reference(record, type.name.span);
          return { kind: "record", name };
        }
        return yield* error(type.name, `Unknown type: ${name}`);
      }
      case "list":
        return { kind: "list", element: yield* resolveType(scope, type.element) };
      case "optional": {
        const inner = yield* resolveType(scope, type.inner);
        if (inner.kind === "optional") return yield* error(type, "A type is optional at most once");
        return { kind: "optional", inner };
      }
    }
  });

const asEntries = (fields: readonly Written[]): readonly Entry[] =>
  fields.map((field): Entry => ({ kind: "field", field }));

/**
 * Resolves one field list: record fields, event payload, or state data. Each entry recovers on its own, so a bad
 * field is dropped and reported without hiding its siblings. `...Placed` splices a record's fields in place, as
 * the record's own `Field`s, so hover and definition on `items` reach `type Placed`.
 */
const collect = (
  scope: Scope,
  owner: Name,
  entries: readonly Entry[],
  kind: "property" | "parameter",
): Check<readonly Field[]> =>
  check<readonly Field[]>(function*() {
    const fields: Field[] = [];
    const claim = (at: Name, name: string): Check<void> =>
      fields.some((field) => field.name.name === name)
        ? error(at, `Duplicate field: ${owner.name}.${name}`)
        : pure(undefined);
    for (const entry of entries) {
      yield* attempt(check(function*() {
        if (entry.kind === "spread") {
          const { name } = entry.record;
          const shape = scope.shapes.get(name);
          if (!shape) {
            return yield* error(
              entry.record,
              scope.enums.has(name) ? `${name} is an enum; only a record spreads` : `Unknown record: ${name}`,
            );
          }
          yield* facts.reference(shape, entry.record.span);
          for (const field of shape.fields) {
            yield* attempt(check(function*() {
              yield* claim(entry.record, field.name.name);
              fields.push(field);
            }));
          }
          return;
        }
        const { name, type } = entry.field;
        if (reserved.field.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a field name`));
        }
        yield* claim(name, name.name);
        const field: Field = { id: Symbol(name.name), name, type: yield* resolveType(scope, type) };
        yield* facts.define({ id: field.id, name: name.name, type: showType(field.type) }, name.span, kind);
        fields.push(field);
      }));
    }
    return fields;
  });

/** Named types in written order, for hover: a type name shows its definition. */
const typeNames = (type: TypeExpr): readonly Name[] =>
  type.kind === "named" ? [type.name] : typeNames(type.kind === "list" ? type.element : type.inner);

const usedTypes = (declaration: Declaration): readonly Name[] => {
  switch (declaration.kind) {
    case "record":
      return declaration.fields.flatMap(({ type }) => typeNames(type));
    case "event":
      return declaration.payload.flatMap(({ type }) => typeNames(type));
    case "state":
      return declaration.entries.flatMap((entry) =>
        entry.kind === "spread" ? [entry.record] : typeNames(entry.field.type)
      );
    case "machine":
    case "enum":
      return [];
  }
};

type Draft = { readonly state: Omit<State, "on">; readonly clauses: readonly On[]; };

type Resolved = {
  readonly events: ReadonlyMap<string, Event>;
  readonly states: ReadonlyMap<string, Draft>;
};

/**
 * One `|> on event -> Target` clause. Both names resolve (and are referenced) before any rule fires, so a typo
 * in each is reported once. Then, in order:
 * - `Delivered is final; a final state handles no events`.
 * - `Paid already handles cancel`: (state, event) picks one target.
 * - Data flow, computing `fill` for every target field: payload by name, else carry by name, else null if the
 *   field is optional, else an error at the target. Every payload field must land.
 * Undefined means the clause was reported and has no edge.
 */
const transition = (
  { events, states }: Resolved,
  from: Draft["state"],
  clause: On,
  handled: readonly Transition[],
): Check<Transition | undefined> =>
  check<Transition | undefined>(function*() {
    const event = events.get(clause.event.name);
    const target = states.get(clause.target.name)?.state;
    if (event) yield* facts.reference(event, clause.event.span);
    else yield* attempt(error(clause.event, `Unknown event: ${clause.event.name}`));
    if (target) yield* facts.reference({ id: target.symbol }, clause.target.span);
    else yield* attempt(error(clause.target, `Unknown state: ${clause.target.name}`));
    if (!event || !target) return undefined;
    if (from.final) return yield* error(clause, `${from.name.name} is final; a final state handles no events`);
    if (handled.some((transition) => transition.event === event)) {
      return yield* error(clause, `${from.name.name} already handles ${event.name.name}`);
    }
    if (from.data.some((field) => field.name.name === event.name.name)) {
      return yield* error(
        clause.event,
        `TypeScript cannot represent ${event.name.name}, which ${from.name.name} has as both a field and an event`,
      );
    }
    const source = (field: Field): Check<Fill> =>
      check<Fill>(function*() {
        const param = event.payload.find(({ name }) => name.name === field.name.name);
        if (param) {
          if (!assignable(param.type, field.type)) {
            return yield* error(
              clause.target,
              `${target.name.name}.${field.name.name} is ${showType(field.type)}, but ${event.name.name} gives ${
                showType(param.type)
              }`,
            );
          }
          return { field, source: { kind: "payload", param } };
        }
        const carried = from.data.find(({ name }) => name.name === field.name.name);
        if (carried) {
          if (!assignable(carried.type, field.type)) {
            return yield* error(
              clause.target,
              `${target.name.name}.${field.name.name} is ${
                showType(field.type)
              }, but ${from.name.name}.${field.name.name} is ${showType(carried.type)}`,
            );
          }
          return { field, source: { kind: "carry", field: carried } };
        }
        if (field.type.kind === "optional") return { field, source: { kind: "null" } };
        return yield* error(
          clause.target,
          `${target.name.name} needs ${field.name.name} : ${
            showType(field.type)
          }; neither ${from.name.name} nor ${event.name.name} provides it`,
        );
      });
    const fill: (Fill | undefined)[] = [];
    for (const field of target.data) fill.push(yield* attempt(source(field)));
    const lost = event.payload.filter(({ name }) => !target.data.some((field) => field.name.name === name.name));
    for (const { name } of lost) {
      yield* attempt(
        error(clause.event, `${event.name.name} gives ${name.name}, which ${target.name.name} has no field for`),
      );
    }
    const filled = fill.filter((value) => value !== undefined);
    if (lost.length || filled.length < fill.length) return undefined;
    return { clause, event, from: from.id, to: target.id, fill: filled };
  });

const finding = (machine: Machine, found: Finding): Check<never> => {
  const initial = machine.states[machine.initial]!.name.name;
  const finals = machine.states.filter(({ final }) => final).map(({ name }) => name.name).join(" or ");
  switch (found.kind) {
    case "unreachable":
      return error(found.state.name, `Unreachable state: ${found.state.name.name}; no path from ${initial}`);
    case "dead end":
      return error(
        found.state.name,
        `${found.state.name.name} is a dead end: it is not final and handles no events`,
      );
    case "cannot finish":
      return error(found.state.name, `${found.state.name.name} can never finish: no path to ${finals}`);
    case "unhandled":
      return error(found.event.name, `No state handles ${found.event.name.name}`);
  }
};

/**
 * The whole pass. Each declaration's checks are recovered so a file reports every independent error; the graph
 * audit runs only when every clause became an edge, so one typo is one diagnostic, not a cascade.
 */
const elaborate = (declarations: readonly Declaration[]): Check<Machine> =>
  check(function*() {
    const declared = yield* declare(declarations);

    const shapes = new Map<string, Shape>();
    for (const { declaration, id } of declared.records.values()) {
      const { name } = declaration;
      const fields = yield* collect(declared, name, asEntries(declaration.fields), "property");
      const shape: Shape = { id, name, fields };
      shapes.set(name.name, shape);
      yield* facts.define({ id, name: name.name, type: showRecord(shape) }, name.span, "interface");
    }
    const scope: Scope = { ...declared, shapes };

    const resolved = { events: new Map<string, Event>(), states: new Map<string, Draft>() };
    for (const { declaration, id } of scope.events.values()) {
      const { name } = declaration;
      const payload = yield* collect(scope, name, asEntries(declaration.payload), "parameter");
      const event: Event = { id, name, payload };
      resolved.events.set(name.name, event);
      yield* facts.define({ id, name: name.name, type: showEvent(event) }, name.span, "method");
    }
    for (const { declaration, id, index } of scope.states.values()) {
      const { name } = declaration;
      const data = yield* collect(scope, name, declaration.entries, "property");
      const state = { id: index, symbol: id, name, final: declaration.role === "final", data };
      resolved.states.set(name.name, { state, clauses: declaration.on });
      yield* facts.define({ id, name: name.name, type: showState(state) }, name.span, "class");
    }

    const states: State[] = [];
    let written = 0;
    for (const { state, clauses } of resolved.states.values()) {
      const on: Transition[] = [];
      written += clauses.length;
      for (const clause of clauses) {
        const edge = yield* transition(resolved, state, clause, on).recover(pure(undefined));
        if (edge) on.push(edge);
      }
      states.push({ ...state, on });
    }

    for (const { on } of states) {
      for (const edge of on) {
        yield* facts.typed(showTransition(states, edge), edge.clause.event.span);
        yield* facts.typed(showState(states[edge.to]!), edge.clause.target.span);
      }
    }
    for (const use of declarations.flatMap(usedTypes)) {
      const enumeration = scope.enums.get(use.name);
      const shape = shapes.get(use.name);
      if (enumeration) yield* facts.typed(showEnum(enumeration), use.span);
      else if (shape) yield* facts.typed(showRecord(shape), use.span);
    }

    const bound = scope.machine
      ?? (yield* error({ span: { start: 0, end: 0 } }, "A .machine file declares one machine"));
    const initials = [...scope.states.values()].filter(({ declaration }) => declaration.role === "initial");
    for (const { declaration } of initials.slice(1)) {
      yield* attempt(error({ span: declaration.marker ?? declaration.name.span }, "Exactly one initial state"));
    }
    const initial = initials[0]?.index ?? (yield* error(bound.declaration.name, "Exactly one initial state"));

    const checked: Machine = {
      id: bound.id,
      name: bound.declaration.name,
      enums: [...scope.enums.values()],
      records: [...shapes.values()],
      events: [...resolved.events.values()],
      states,
      initial,
    };
    if (states.reduce((count, { on }) => count + on.length, 0) === written) {
      for (const found of audit(checked)) yield* attempt(finding(checked, found));
    }
    return checked;
  });

export const checkSource = (source: string): Result<Machine> => {
  const parsed = parse(source);
  return parsed.success ? run(elaborate(parsed.value)) : parsed;
};

export const analyze = (source: string): Analysis<Type> => {
  const lexical = highlight(source, tokens);
  const parsed = parse(source);
  if (!parsed.success) return unanalyzed(parsed.errors, lexical);
  return facts.collect(elaborate(parsed.value), lexical).analysis;
};

/** The CLI fold: a Mermaid stateDiagram. Proves the IR alone draws the machine. */
export const mermaid = ({ states, initial }: Machine): string =>
  [
    "stateDiagram-v2",
    `  [*] --> ${states[initial]!.name.name}`,
    ...states.flatMap(({ name, on, final }) => [
      ...on.map(({ event, to }) => `  ${name.name} --> ${states[to]!.name.name}: ${event.name.name}`),
      ...(final ? [`  ${name.name} --> [*]`] : []),
    ]),
    "",
  ].join("\n");

if (import.meta.main) {
  const source = readFileSync(process.argv[2] ?? new URL("./checkout.machine", import.meta.url), "utf8");
  const result = checkSource(source);
  if (result.success) process.stdout.write(mermaid(result.value));
  else {
    for (const error of result.errors) console.error(render(error, source));
    process.exitCode = 1;
  }
}
