import { type Check, check, get, push, scoped, within } from "./check.ts";
import type { Span } from "./diagnostic.ts";

export type Operator = "+" | "-" | "*" | "/" | ">" | "==";
export type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T; };
export type Declaration<T> = { readonly recursive?: true; readonly binding: Binding<T>; readonly value: Value<T>; };
export type Body<T> = { readonly declarations: readonly Declaration<T>[]; readonly result: Value<T>; };
export type RecordField<T> = { readonly name: string; readonly value: Value<T>; };
export type MatchCase<T> = { readonly tag: string; readonly bindings: readonly Binding<T>[]; readonly body: Body<T>; };
export type MatchFallback<T> = { readonly binding?: Binding<T>; readonly body: Body<T>; };
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json; };
export type Import<T> = {
  readonly from: string;
  readonly names: readonly (readonly [exported: string, binding: Binding<T>])[];
};
/** An ES module whose `body.result` is its default export. */
export type Module<T> = {
  readonly imports: readonly Import<T>[];
  readonly body: Body<T>;
  readonly exports: readonly (readonly [name: string, binding: Binding<T>])[];
};

export type Value<T> =
  & { readonly type: T; readonly span?: Span; }
  & (
    | { readonly kind: "literal"; readonly value: number | boolean | string; }
    | { readonly kind: "data"; readonly value: Json; }
    | { readonly kind: "ref"; readonly binding: Binding<T>; }
    | { readonly kind: "binary"; readonly op: Operator; readonly left: Value<T>; readonly right: Value<T>; }
    | { readonly kind: "call"; readonly fn: Value<T>; readonly arg: Value<T>; }
    | { readonly kind: "fn"; readonly param: Binding<T>; readonly body: Body<T>; }
    | { readonly kind: "conditional"; readonly cond: Value<T>; readonly then: Body<T>; readonly else: Body<T>; }
    | { readonly kind: "block"; readonly body: Body<T>; }
    | { readonly kind: "record"; readonly fields: readonly RecordField<T>[]; readonly base?: Value<T>; }
    | { readonly kind: "field"; readonly record: Value<T>; readonly name: string; }
    | { readonly kind: "variant"; readonly tag: string; readonly fields: readonly Value<T>[]; }
    | {
      readonly kind: "match";
      readonly value: Value<T>;
      readonly cases: readonly MatchCase<T>[];
      readonly fallback?: MatchFallback<T>;
    }
    | { readonly kind: "print"; readonly value: Value<T>; }
  );
export type Reference<T> = Extract<Value<T>, { readonly kind: "ref"; }>;

export const binding = <T>(name: string, type: T): Binding<T> => ({ id: Symbol(name), name, type });
export const ref = <T>(target: Binding<T>, type: T = target.type): Reference<T> => ({
  type,
  kind: "ref",
  binding: target,
});
export const literal = <T>(type: T, value: number | boolean | string): Value<T> => ({ type, kind: "literal", value });
export const data = <T>(type: T, value: Json): Value<T> => ({ type, kind: "data", value });
export const binary = <T>(type: T, op: Operator, left: Value<T>, right: Value<T>): Value<T> => ({
  type,
  kind: "binary",
  op,
  left,
  right,
});
export const call = <T>(type: T, callee: Value<T>, arg: Value<T>): Value<T> => ({
  type,
  kind: "call",
  fn: callee,
  arg,
});
export const record = <T>(type: T, fields: readonly RecordField<T>[], base?: Value<T>): Value<T> =>
  base ? { type, kind: "record", fields, base } : { type, kind: "record", fields };
export const field = <T>(type: T, target: Value<T>, name: string): Value<T> => ({
  type,
  kind: "field",
  record: target,
  name,
});
export const variant = <T>(type: T, tag: string, fields: readonly Value<T>[]): Value<T> => ({
  type,
  kind: "variant",
  tag,
  fields,
});
export const match = <T>(
  type: T,
  matched: Value<T>,
  cases: readonly MatchCase<T>[],
  fallback?: MatchFallback<T>,
): Value<T> =>
  fallback ? { type, kind: "match", value: matched, cases, fallback } : { type, kind: "match", value: matched, cases };
export const print = <T>(type: T, printed: Value<T>): Value<T> => ({ type, kind: "print", value: printed });
export const fn = <T>(type: T, param: Binding<T>, body: Body<T>): Value<T> => ({ type, kind: "fn", param, body });
export const conditional = <T>(type: T, cond: Value<T>, then: Body<T>, otherwise: Body<T>): Value<T> => ({
  type,
  kind: "conditional",
  cond,
  then,
  else: otherwise,
});
export const block = <T>(type: T, body: Body<T>): Value<T> => ({ type, kind: "block", body });
export const at = <T>(value: Value<T>, span: Span): Value<T> => ({ ...value, span });

const active = scoped<Declaration<unknown>[] | undefined>(undefined);

/** Builds the declaration per run, so a check reused across runs mints fresh bindings. */
const collect = <T>(declaration: () => Declaration<T>): Check<Reference<T>> =>
  check(function*() {
    const declarations = yield* get(active);
    if (!declarations) throw new Error("IR declarations need an enclosing body");
    const declared = declaration();
    yield* push(declarations, declared);
    return ref(declared.binding);
  });

export const declare = <T>(name: string, initial: Value<T>): Check<Reference<T>> =>
  collect(() => ({ binding: binding(name, initial.type), value: initial }));

export const declareRecursive = <T>(target: Binding<T>, initial: Value<T>): Check<Reference<T>> => {
  if (initial.kind !== "fn") throw new Error("Recursive declarations require a function initializer");
  return collect(() => ({ binding: target, value: initial, recursive: true }));
};

/** Collects the declarations `result` makes into a fresh body; the copy survives a later rollback. */
export const body = <T>(result: Check<Value<T>>): Check<Body<T>> =>
  check(function*() {
    const declarations: Declaration<T>[] = [];
    const value = yield* within(active, () => declarations, result);
    return { declarations: [...declarations], result: value };
  });

export const scope = <T>(result: Check<Value<T>>): Check<Value<T>> =>
  body(result).map((built) => block(built.result.type, built));
