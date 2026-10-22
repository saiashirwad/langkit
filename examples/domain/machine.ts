import { type Check, check, pure } from "langkit";
import {
  assignable,
  type Event,
  type Field,
  type Fill,
  type Machine,
  showEvent,
  showState,
  showTransition,
  showType,
  type State,
  type StateId,
  stateId,
  type Transition,
} from "./domain-model.ts";
import type { Declaration, MachineItem, Name, On } from "./domain-syntax.ts";
import { audit, type Finding } from "./graph.ts";
import { attempt, type Binder, error, facts, reserved, type Scope } from "./scope.ts";
import { asEntries, collect } from "./types.ts";

export type MachineDeclaration = Extract<Declaration, { readonly kind: "machine"; }>;

type Item<K extends MachineItem["kind"]> = Extract<MachineItem, { readonly kind: K; }>;

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
 * Binds events and states. States share the file's type namespace, since each becomes a TypeScript interface
 * inside `namespace Order`; events have their own, since they become methods.
 */
const declare = (scope: Scope, items: readonly MachineItem[]) =>
  check(function*() {
    const events = new Map<string, { readonly item: Item<"event">; readonly id: symbol; }>();
    const states = new Map<string, { readonly item: Item<"state">; readonly id: symbol; readonly index: StateId; }>();
    const claim = (name: Name): Check<void> =>
      check(function*() {
        if (reserved.state.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a state name`));
        }
        if (reserved.type.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a reserved type name`));
        }
        // A state that shadows a top-level name is still the machine's state, so its clauses are checked.
        if (scope.top.has(name.name)) yield* attempt(error(name, `Duplicate declaration: ${name.name}`));
        if (states.has(name.name)) return yield* error(name, `Duplicate declaration: ${name.name}`);
      });
    for (const item of items) {
      const { name } = item;
      yield* attempt(check(function*() {
        switch (item.kind) {
          case "event":
            if (reserved.event.has(name.name)) {
              yield* attempt(error(name, `TypeScript cannot represent ${name.name}, an event name`));
            }
            if (events.has(name.name)) return yield* error(name, `Duplicate event: ${name.name}`);
            events.set(name.name, { item, id: Symbol(name.name) });
            return;
          case "state":
            yield* claim(name);
            states.set(name.name, { item, id: Symbol(name.name), index: stateId(states.size) });
            return;
        }
      }));
    }
    return { events, states };
  });

/**
 * v1's elaboration inside `machine Order { ... }`. Each item's checks are recovered so a file reports every
 * independent error; the graph audit runs only when every clause became an edge, so one typo is one
 * diagnostic, not a cascade.
 */
export const elaborateMachine = (scope: Scope, declaration: MachineDeclaration, binder: Binder): Check<Machine> =>
  check(function*() {
    const declared = yield* declare(scope, declaration.items);

    const resolved = { events: new Map<string, Event>(), states: new Map<string, Draft>() };
    for (const { item, id } of declared.events.values()) {
      const { name } = item;
      const payload = yield* collect(scope, name, asEntries(item.payload), "parameter");
      const event: Event = { id, name, payload };
      resolved.events.set(name.name, event);
      yield* facts.define({ id, name: name.name, type: showEvent(event) }, name.span, "method");
    }
    for (const { item, id, index } of declared.states.values()) {
      const { name } = item;
      const data = yield* collect(scope, name, item.entries, "property");
      const state = { id: index, symbol: id, name, final: item.role === "final", data };
      resolved.states.set(name.name, { state, clauses: item.on });
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

    const { name } = declaration;
    yield* facts.define({ id: binder.id, name: name.name, type: `machine ${name.name}` }, name.span, "namespace");
    const initials = [...declared.states.values()].filter(({ item }) => item.role === "initial");
    for (const { item } of initials.slice(1)) {
      yield* attempt(error({ span: item.marker ?? item.name.span }, "Exactly one initial state"));
    }
    const initial = initials[0]?.index ?? (yield* error(name, "Exactly one initial state"));

    const machine: Machine = {
      id: binder.id,
      uri: binder.uri,
      name,
      events: [...resolved.events.values()],
      states,
      initial,
    };
    if (states.reduce((count, { on }) => count + on.length, 0) === written) {
      for (const found of audit(machine)) yield* attempt(finding(machine, found));
    }
    return machine;
  });
