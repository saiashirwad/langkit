import { type Check, check, pure } from "langkit";
import * as ir from "langkit/ir";
import type { RecordField, Value } from "langkit/ir";
import * as rank from "langkit/types/higher-rank";

export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type IsAny<T> = 0 extends (1 & T) ? true : false;
export type IsNever<T> = [T] extends [never] ? true : false;
export const prove = <T extends true>(): T => true as T;
export type Type = rank.Type;

export type RecordValue = Extract<Value<Type>, { readonly kind: "record"; }>;
export type LiteralValue = Extract<Value<Type>, { readonly kind: "literal"; }>;

export const describe = (value: Value<Type>): string => {
  switch (value.kind) {
    case "literal": {
      const literalValue = value;
      prove<Equal<typeof literalValue, LiteralValue>>();
      prove<Equal<typeof literalValue.value, number | boolean | string>>();
      prove<Equal<IsAny<typeof literalValue>, false>>();
      prove<Equal<IsNever<typeof literalValue>, false>>();
      return JSON.stringify(literalValue.value);
    }
    case "record": {
      const recordValue = value;
      prove<Equal<typeof recordValue, RecordValue>>();
      prove<Equal<typeof recordValue.fields, readonly RecordField<Type>[]>>();
      prove<Equal<IsAny<typeof recordValue>, false>>();
      prove<Equal<IsNever<typeof recordValue>, false>>();
      return recordValue.fields.map((field) => `${field.name}: ${describe(field.value)}`)
        .join(", ");
    }
    default:
      return value.kind;
  }
};

export const inferred = check(function*() {
  const yielded = yield* pure("ready" as const);
  prove<Equal<typeof yielded, "ready">>();
  prove<Equal<IsAny<typeof yielded>, false>>();
  prove<Equal<IsNever<typeof yielded>, false>>();
  const tuple = yield* pure(["label", 42, true] as ["label", 42, true]);
  prove<Equal<typeof tuple, ["label", 42, true]>>();
  prove<Equal<IsAny<typeof tuple>, false>>();
  prove<Equal<IsNever<typeof tuple>, false>>();
  return tuple;
});
prove<Equal<typeof inferred, Check<["label", 42, true]>>>();

export const theoryConsumer: Check<rank.Variable> = check(function*() {
  const rankVariable = rank.fresh(1);
  prove<Equal<typeof rankVariable, rank.Variable>>();
  return rankVariable;
});

export const freshVariable = check(function*() {
  const variable = rank.fresh();
  prove<Equal<typeof variable, rank.Variable>>();
  prove<Equal<IsAny<typeof variable>, false>>();
  prove<Equal<IsNever<typeof variable>, false>>();
  return variable;
});

export const namedValue: Value<Type> = ir.literal(rank.number, 42);
export const namedCheck: Check<Value<Type>> = pure(namedValue);
