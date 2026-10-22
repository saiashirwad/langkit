// The interpreter the emitted modules call. It knows nothing of the guest syntax.
//
// Invariants:
// 1. Every live value conforms to its state's data. Values come only from start, a transition, or parse, and each
//    decodes its input against a Shape, so JS callers that skip the types still cannot build a bad value.
// 2. Values are deeply frozen. A transition returns a new value and never touches the old one, so a stale value
//    stays valid (and typed) forever. Firing the same event on the same value twice gives equal results.
// 3. `JSON.stringify(value)` is the snapshot: `state` then the data fields, in declared order. Event methods live
//    on one frozen prototype per state, so they never serialize. `parse(JSON.parse(JSON.stringify(v)))` deep-equals v.
// 4. The table is the whole program: a transition reads `fill` and copies. No guards, no effects.
// 5. Each module's tables close over every type they decode, own or imported, so a module imports only this file.
// 6. A named type's `parse` decodes against its table entry; a brand decodes as its scalar.
// 7. A sync is all or nothing. It checks that every part is in a state that handles its port's event before firing
//    any, and firing is pure, so a refused sync changes nothing and a repeated one returns equal values.
// 8. A `sync event` has no method; only a system fires it, through `fire`, which never leaves this module.

import { type Data, decodeFields, type Fields, found, isObject, type Types } from "../data/decode.ts";

export { named } from "../data/decode.ts";

/** The decided data flow for one target field; mirrors domain-model's Source. */
export type Fill = readonly [field: string, source: "payload" | "carry" | "null"];

export type Edge = { readonly event: string; readonly to: string; readonly fill: readonly Fill[]; };

export type CompiledState = { readonly name: string; readonly data: Fields; readonly on: readonly Edge[]; };

/** The JSON the host embeds with `data(...)`. Built from the IR by domain-host's `compiled`. */
export type CompiledMachine = {
  readonly name: string;
  readonly initial: string;
  readonly events: Readonly<Record<string, Fields>>;
  /** Events declared `sync event`: no method on the values, only `fire`. */
  readonly syncOnly: readonly string[];
  readonly states: readonly CompiledState[];
};

/** One port of a sync: the states that handle its event, and the merged payload fields it takes. */
export type CompiledPort = {
  readonly component: string;
  readonly event: string;
  readonly handles: readonly string[];
  readonly fields: readonly string[];
};

export type CompiledFormula =
  | { readonly kind: "is"; readonly component: string; readonly negated: boolean; readonly states: readonly string[]; }
  | { readonly kind: "and" | "or"; readonly left: CompiledFormula; readonly right: CompiledFormula; };

export type CompiledSystem = {
  readonly name: string;
  readonly syncs: readonly { readonly name: string; readonly ports: readonly CompiledPort[]; }[];
  /** One per `never` property: true when the parts are not in a state the formula forbids. */
  readonly predicates: readonly { readonly name: string; readonly bad: CompiledFormula; }[];
};

const fire = Symbol("fire");

type Fire = (event: string, payload: unknown) => Value;

export type Value = { readonly state: string; readonly [field: string]: unknown; };

export type Machine = {
  readonly start: (data?: unknown) => Value;
  readonly parse: (snapshot: unknown) => Value;
};

/**
 * Builds one frozen prototype per state up front. Each edge becomes a method that decodes its payload, then
 * copies each target field from where `fill` says. Methods read `this`, so a detached `const { pay } = checkout`
 * throws; the projection declares them as methods.
 */
export const machine = (types: Types) => (table: CompiledMachine): Machine => {
  const prototypes = new Map<string, object>();
  const make = (state: string, data: Data): Value =>
    Object.freeze(Object.assign(Object.create(prototypes.get(state)!), { state }, data));
  for (const { name, on } of table.states) {
    const edges = on.map(({ event, to, fill }) => {
      const method = function(this: Value, payload: unknown = {}): Value {
        const given = decodeFields(types, table.events[event]!, payload, `${table.name}.${name}.${event}`);
        return make(
          to,
          Object.fromEntries(fill.map(([field, source]) => [
            field,
            source === "payload" ? given[field] : source === "carry" ? this[field] : null,
          ])),
        );
      };
      return [event, method] as const;
    });
    const byEvent = new Map(edges);
    const fires: Fire = function(this: Value, event, payload) {
      return byEvent.get(event)!.call(this, payload);
    };
    const methods = edges.filter(([event]) => !table.syncOnly.includes(event));
    prototypes.set(name, Object.freeze({ ...Object.fromEntries(methods), [fire]: fires }));
  }
  const states = new Map(table.states.map((state) => [state.name, state]));
  return {
    start: (data = {}) =>
      make(
        table.initial,
        decodeFields(types, states.get(table.initial)!.data, data, `${table.name}.start`),
      ),
    parse: (snapshot) => {
      if (!isObject(snapshot)) throw new TypeError(`snapshot: expected an object, found ${found(snapshot)}`);
      const { state, ...rest } = snapshot;
      const target = typeof state === "string" ? states.get(state) : undefined;
      if (!target) {
        const members = table.states.map(({ name }) => JSON.stringify(name)).join(" | ");
        throw new TypeError(`snapshot.state: expected ${members}, found ${found(state)}`);
      }
      return make(target.name, decodeFields(types, target.data, rest, "snapshot"));
    },
  };
};

const satisfies = (formula: CompiledFormula, parts: Data): boolean => {
  switch (formula.kind) {
    case "is":
      return formula.states.includes((parts[formula.component] as Value).state) !== formula.negated;
    case "and":
      return satisfies(formula.left, parts) && satisfies(formula.right, parts);
    case "or":
      return satisfies(formula.left, parts) || satisfies(formula.right, parts);
  }
};

/**
 * `Shop.pay({ order, payment, warehouse })` -> `{ order: Paid, payment: Captured, warehouse: Reserved }`, frozen.
 * A part that cannot take its event throws `TypeError: Shop.pay: order is Cart, which does not handle pay`, before
 * any part fires. Each port takes only its own fields from the merged payload; a predicate reads only `state`.
 */
export const system = (table: CompiledSystem): Readonly<Record<string, (...args: never[]) => unknown>> => {
  const syncs = table.syncs.map(({ name, ports }) => {
    const where = `${table.name}.${name}`;
    const accepted = new Set(ports.flatMap(({ fields }) => fields));
    const run = (parts: unknown, payload: unknown = {}) => {
      if (!isObject(parts)) throw new TypeError(`${where}: expected the parts, found ${found(parts)}`);
      if (!isObject(payload)) throw new TypeError(`${where}: expected an object, found ${found(payload)}`);
      for (const key of Object.keys(payload)) {
        if (!accepted.has(key)) throw new TypeError(`${where}: unexpected field ${key}`);
      }
      for (const { component, event, handles } of ports) {
        const part = parts[component];
        if (!isObject(part) || typeof Reflect.get(part, fire) !== "function") {
          throw new TypeError(`${where}: ${component} is not a machine value, found ${found(part)}`);
        }
        if (!handles.includes(part.state as string)) {
          throw new TypeError(`${where}: ${component} is ${String(part.state)}, which does not handle ${event}`);
        }
      }
      return Object.freeze(Object.fromEntries(ports.map(({ component, event, fields }) => {
        const part = parts[component] as Value & { readonly [fire]: Fire; };
        const own = Object.fromEntries(
          fields.filter((field) => Object.hasOwn(payload, field)).map((field) => [
            field,
            payload[field],
          ]),
        );
        return [component, part[fire](event, own)];
      })));
    };
    return [name, run] as const;
  });
  const predicates = table.predicates.map(({ name, bad }) => [name, (parts: Data) => !satisfies(bad, parts)] as const);
  return Object.freeze(Object.fromEntries([...syncs, ...predicates]));
};
