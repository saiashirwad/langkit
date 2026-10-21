import type { Span } from "./diagnostic.ts";

export type Operator = "+" | "-" | "*" | "/" | ">" | "==";
export type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T; };
export type Declaration<T> = { readonly recursive?: true; readonly binding: Binding<T>; readonly value: Value<T>; };
export type Body<T> = { readonly declarations: readonly Declaration<T>[]; readonly result: Value<T>; };
export type BodySource<T> = Body<T> | (() => Generator<Declaration<T>, Value<T>, unknown>);
export type RecordField<T> = { readonly name: string; readonly value: Value<T>; };
export type MatchCase<T> = { readonly tag: string; readonly bindings: readonly Binding<T>[]; readonly body: Body<T>; };
export type MatchFallback<T> = { readonly binding?: Binding<T>; readonly body: Body<T>; };

export type Value<T> =
  & { readonly type: T; readonly span?: Span; }
  & (
    | { readonly kind: "literal"; readonly value: number | boolean | string; }
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
export const at = <T>(value: Value<T>, span: Span): Value<T> => ({ ...value, span });

export const body = <T>(source: BodySource<T>): Body<T> => {
  if (typeof source !== "function") return source;
  const declarations: Declaration<T>[] = [];
  const iterator = source();
  let step = iterator.next();
  for (; !step.done; step = iterator.next()) declarations.push(step.value);
  return { declarations, result: step.value };
};
export const fn = <T>(type: T, param: Binding<T>, source: BodySource<T>): Value<T> => ({
  type,
  kind: "fn",
  param,
  body: body(source),
});
export const conditional = <T>(type: T, cond: Value<T>, then: BodySource<T>, otherwise: BodySource<T>): Value<T> => ({
  type,
  kind: "conditional",
  cond,
  then: body(then),
  else: body(otherwise),
});
export const block = <T>(type: T, source: BodySource<T>): Value<T> => ({ type, kind: "block", body: body(source) });
export const scope = <T>(source: BodySource<T>): Value<T> => {
  const built = body(source);
  return block(built.result.type, built);
};

export function* declare<T>(name: string, initial: Value<T>): Generator<Declaration<T>, Reference<T>, unknown> {
  const target = binding(name, initial.type);
  yield { binding: target, value: initial };
  return ref(target);
}
export function* declareRecursive<T>(
  target: Binding<T>,
  initial: Value<T>,
): Generator<Declaration<T>, Reference<T>, unknown> {
  if (initial.kind !== "fn") throw new Error("Recursive declarations require a function initializer");
  yield { binding: target, value: initial, recursive: true };
  return ref(target);
}

export const create = <T>() => ({
  binding: binding<T>,
  ref: ref<T>,
  body: body<T>,
  declare: declare<T>,
  declareRecursive: declareRecursive<T>,
  literal: literal<T>,
  binary: binary<T>,
  call: call<T>,
  fn: fn<T>,
  conditional: conditional<T>,
  block: block<T>,
  scope: scope<T>,
  record: record<T>,
  field: field<T>,
  variant: variant<T>,
  match: match<T>,
  print: print<T>,
  at: at<T>,
});
export type Builder<T> = ReturnType<typeof create<T>>;
