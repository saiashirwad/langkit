// The interpreter the emitted modules call. It knows nothing of the guest syntax.
//
// Invariants:
// 1. Every live value conforms to its machine's cells and signals. Values come only from start, an input, or
//    parse. An input decodes what it is given against what it carries, and the checker proved every row and
//    signal builds a value of its type, so JS callers that skip the types still cannot build a bad value.
// 2. Values are deeply frozen. An input returns a new value and never touches the old one, so a stale value stays
//    valid (and typed) forever. The same input on the same value twice gives equal results.
// 3. `JSON.stringify(value)` is the snapshot: the cells, then the signals of the last tick, each in declared
//    order. Input methods live on one frozen prototype, so they never serialize.
//    `parse(JSON.parse(JSON.stringify(v)))` deep-equals v.
// 4. One input is one tick. Signals start each tick absent, and nodes run in table order, which the checker made
//    causal, so every node reads the values this tick already gave the nodes before it. A cell's own rows match
//    the value it started the tick with.
// 5. The table is the checked IR, with names where the IR holds references. This file is the only interpreter.
// 6. Each module's tables close over every type they decode, so a module imports only this file.

import {
  type Data,
  decode,
  decodeFields,
  describe,
  type Fields,
  found,
  type Shape,
  type Types,
} from "../data/decode.ts";

export { named } from "../data/decode.ts";

/** A local is a group's binder or a pattern's binding, `..` for an anonymous rest; a slot is a cell or signal. */
export type CompiledRef = { readonly kind: "local" | "slot"; readonly name: string; };

export type CompiledExpr =
  | CompiledRef
  | { readonly kind: "field"; readonly record: CompiledExpr; readonly field: string; }
  | { readonly kind: "member"; readonly member: string; }
  | { readonly kind: "variant"; readonly tag: string; readonly fields: readonly (readonly [string, CompiledExpr])[]; }
  /** Every field in declared order; null is an omitted optional. */
  | { readonly kind: "record"; readonly fields: readonly (readonly [string, CompiledExpr | null])[]; }
  | {
    readonly kind: "list";
    readonly items: readonly { readonly spread: boolean; readonly value: CompiledExpr; }[];
  };

export type CompiledPattern =
  | { readonly kind: "wild"; }
  | { readonly kind: "bind"; readonly name: string; }
  | { readonly kind: "equal"; readonly ref: CompiledRef; }
  | { readonly kind: "member"; readonly member: string; }
  /** `args` is null for a tag test, `Loop`. */
  | {
    readonly kind: "variant";
    readonly tag: string;
    readonly args: readonly (readonly [string, CompiledPattern])[] | null;
  }
  | { readonly kind: "record"; readonly fields: readonly (readonly [string, CompiledPattern])[]; }
  | { readonly kind: "tuple"; readonly items: readonly CompiledPattern[]; }
  | {
    readonly kind: "spread";
    readonly head: readonly CompiledPattern[];
    readonly rest: string;
    readonly tail: readonly CompiledPattern[];
  };

export type CompiledFormula =
  | { readonly kind: "is" | "contains"; readonly subject: CompiledExpr; readonly pattern: CompiledPattern; }
  | { readonly kind: "and" | "or"; readonly left: CompiledFormula; readonly right: CompiledFormula; }
  | { readonly kind: "not"; readonly operand: CompiledFormula; };

export type CompiledRow = {
  readonly pattern: CompiledPattern;
  readonly guard: { readonly sense: "if" | "unless"; readonly formula: CompiledFormula; } | null;
  readonly value: CompiledExpr;
};

/** `source` names an input or a signal; they share one namespace. */
export type CompiledGroup = {
  readonly source: string;
  readonly binder: string | null;
  readonly rows: readonly CompiledRow[];
};

export type CompiledNode =
  /** `carried` is which of the input's carried types the cell keeps. */
  | { readonly kind: "last"; readonly name: string; readonly input: string; readonly carried: number; }
  | {
    readonly kind: "value";
    readonly name: string;
    readonly initial: CompiledExpr;
    readonly groups: readonly CompiledGroup[];
  }
  | {
    readonly kind: "signal";
    readonly name: string;
    readonly input: string;
    readonly present: readonly string[];
    readonly value: CompiledExpr;
  };

/** The JSON the host embeds with `data(...)`. Built from the IR by reactor-host's `compiled`. */
export type CompiledMachine = {
  readonly name: string;
  readonly inputs: readonly { readonly name: string; readonly carries: readonly Shape[]; }[];
  /** The snapshot's fields: cells, then signals as optionals, each in declared order. */
  readonly fields: Fields;
  /** Cells and signals in the order a tick runs them. */
  readonly nodes: readonly CompiledNode[];
};

export type Machine = {
  readonly start: () => Data;
  readonly parse: (snapshot: unknown) => Data;
};

type Scope = { readonly slots: ReadonlyMap<string, unknown>; readonly locals: Map<string, unknown>; };

const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => equal(Reflect.get(a, key), Reflect.get(b, key)));
};

const read = ({ slots, locals }: Scope, { kind, name }: CompiledRef): unknown =>
  kind === "local" ? locals.get(name) : slots.get(name);

const evaluate = (scope: Scope, expr: CompiledExpr): unknown => {
  switch (expr.kind) {
    case "local":
    case "slot":
      return read(scope, expr);
    case "field":
      return (evaluate(scope, expr.record) as Data)[expr.field];
    case "member":
      return expr.member;
    case "variant":
      return Object.freeze({
        tag: expr.tag,
        ...Object.fromEntries(expr.fields.map(([name, value]) => [name, evaluate(scope, value)])),
      });
    case "record":
      return Object.freeze(Object.fromEntries(
        expr.fields.map(([name, value]) => [name, value === null ? null : evaluate(scope, value)]),
      ));
    case "list":
      return Object.freeze(expr.items.flatMap(({ spread, value }) => {
        const item = evaluate(scope, value);
        return spread ? item as readonly unknown[] : [item];
      }));
  }
};

/** Binds into `scope.locals` left to right, so a name bound earlier in the pattern is already there to compare. */
const matches = (scope: Scope, pattern: CompiledPattern, value: unknown): boolean => {
  switch (pattern.kind) {
    case "wild":
      return true;
    case "bind":
      scope.locals.set(pattern.name, value);
      return true;
    case "equal":
      return equal(value, read(scope, pattern.ref));
    case "member":
      return value === pattern.member;
    case "variant": {
      const data = value as Data;
      return data.tag === pattern.tag
        && (pattern.args ?? []).every(([field, nested]) => matches(scope, nested, data[field]));
    }
    case "record":
      return pattern.fields.every(([field, nested]) => matches(scope, nested, (value as Data)[field]));
    case "tuple": {
      const items = value as readonly unknown[];
      return items.length === pattern.items.length
        && pattern.items.every((nested, index) => matches(scope, nested, items[index]));
    }
    case "spread": {
      const items = value as readonly unknown[];
      const { head, rest, tail } = pattern;
      const end = items.length - tail.length;
      if (end < head.length) return false;
      if (!head.every((nested, index) => matches(scope, nested, items[index]))) return false;
      if (!tail.every((nested, index) => matches(scope, nested, items[end + index]))) return false;
      scope.locals.set(rest, Object.freeze(items.slice(head.length, end)));
      return true;
    }
  }
};

/** A test's bindings stay inside the test. */
const holds = (scope: Scope, formula: CompiledFormula): boolean => {
  const inner = (): Scope => ({ slots: scope.slots, locals: new Map(scope.locals) });
  switch (formula.kind) {
    case "is":
      return matches(inner(), formula.pattern, evaluate(scope, formula.subject));
    case "contains":
      return (evaluate(scope, formula.subject) as readonly unknown[]).some((item) =>
        matches(inner(), formula.pattern, item)
      );
    case "and":
      return holds(scope, formula.left) && holds(scope, formula.right);
    case "or":
      return holds(scope, formula.left) || holds(scope, formula.right);
    case "not":
      return !holds(scope, formula.operand);
  }
};

/** What one input brought: which input, which of its carried types (null if it carries none), and the value. */
type Given = { readonly input: string; readonly carried: number | null; readonly value: unknown; };

/**
 * The groups whose source fired this tick, in order, rows first-match: the first row that matches and whose
 * guard allows it gives the cell's next value. No match keeps the value.
 */
const rewrite = (
  slots: ReadonlyMap<string, unknown>,
  fired: ReadonlySet<string>,
  given: Given,
  node: Extract<CompiledNode, { readonly kind: "value"; }>,
): unknown => {
  const current = slots.get(node.name);
  for (const { source, binder, rows } of node.groups) {
    if (!fired.has(source)) continue;
    const bound = source === given.input ? given.value : slots.get(source);
    for (const { pattern, guard, value } of rows) {
      const scope: Scope = { slots, locals: new Map(binder === null ? [] : [[binder, bound]]) };
      if (!matches(scope, pattern, current)) continue;
      if (guard && holds(scope, guard.formula) !== (guard.sense === "if")) continue;
      return evaluate(scope, value);
    }
  }
  return current;
};

const tick = (table: CompiledMachine, previous: Data, given: Given): Data => {
  const slots = new Map<string, unknown>();
  const fired = new Set([given.input]);
  for (const node of table.nodes) slots.set(node.name, node.kind === "signal" ? null : previous[node.name]);
  for (const node of table.nodes) {
    switch (node.kind) {
      case "last":
        if (node.input === given.input && node.carried === given.carried) slots.set(node.name, given.value);
        break;
      case "signal":
        if (node.input === given.input && node.present.every((cell) => slots.get(cell) !== null)) {
          slots.set(node.name, evaluate({ slots, locals: new Map() }, node.value));
          fired.add(node.name);
        }
        break;
      case "value":
        slots.set(node.name, rewrite(slots, fired, given, node));
        break;
    }
  }
  return Object.fromEntries(table.fields.map(([name]) => [name, slots.get(name)]));
};

/**
 * Decodes an input's argument. Two or more carried types are enums with no member in common, so the member says
 * which type it is.
 */
const take = (types: Types, input: string, carries: readonly Shape[], argument: unknown, path: string): Given => {
  if (carries.length === 1) return { input, carried: 0, value: decode(types, carries[0]!, argument, path) };
  const carried = carries.findIndex((shape) => {
    const named = shape.kind === "named" ? types[shape.key] : undefined;
    return named?.kind === "enum" && named.members.includes(argument as string);
  });
  if (carried >= 0) return { input, carried, value: argument };
  const expected = carries.map((shape) => describe(types, shape)).join(" | ");
  throw new TypeError(`${path}: expected ${expected}, found ${found(argument)}`);
};

/**
 * One frozen prototype holds a method per input; each decodes its argument and runs one tick. Methods read
 * `this`, so a detached `const { press } = player` throws; the projection declares them as methods.
 */
export const machine = (types: Types) => (table: CompiledMachine): Machine => {
  const methods = table.inputs.map(({ name, carries }) => {
    const where = `${table.name}.${name}`;
    const method = function(this: Data, ...args: readonly unknown[]): Data {
      if (carries.length) return make(tick(table, this, take(types, name, carries, args[0], where)));
      if (args.length) throw new TypeError(`${where}: takes nothing, found ${found(args[0])}`);
      return make(tick(table, this, { input: name, carried: null, value: null }));
    };
    return [name, method] as const;
  });
  const prototype = Object.freeze(Object.fromEntries(methods));
  const make = (data: Data): Data => Object.freeze(Object.assign(Object.create(prototype), data));
  const empty: Scope = { slots: new Map(), locals: new Map() };
  const initial = new Map(table.nodes.map((node) => [node.name, node.kind === "value" ? node.initial : null]));
  return {
    start: () =>
      make(Object.fromEntries(table.fields.map(([name]) => {
        const value = initial.get(name);
        return [name, value ? evaluate(empty, value) : null];
      }))),
    parse: (snapshot) => make(decodeFields(types, table.fields, snapshot, "snapshot")),
  };
};
