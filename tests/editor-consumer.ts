import { check, pure, sequence, type Check } from "langkit";
import { create, type Value } from "langkit/ir";
import { defineDialect, type DescriptorNode } from "langkit/operations/dialect";
import { records } from "langkit/operations/records";
import { defineJavaScriptBackend } from "langkit/javascript/operations";
import type { JavaScriptContext } from "langkit/javascript";
import * as hm from "langkit/types/hm";
import * as rows from "langkit/types/rows";
import * as rank from "langkit/types/higher-rank";

export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type IsAny<T> = 0 extends (1 & T) ? true : false;
export type IsNever<T> = [T] extends [never] ? true : false;
export const prove = <T extends true>(): T => true as T;
export type Type = rows.Type;
export type RecordField = { readonly name: string; readonly value: Value<Type> };

const language = create<Type>();
const recordFeature = records<Type>();
const descriptors = { literal: language.coreDescriptors.literal, record: recordFeature.descriptors.record };
export type RecordNode = DescriptorNode<typeof descriptors.record>;
export type LiteralNode = DescriptorNode<typeof descriptors.literal>;
prove<Equal<keyof typeof descriptors, "literal" | "record">>();

export const backend = defineJavaScriptBackend(defineDialect(descriptors), {
  literal: (literalNode) => {
    prove<Equal<typeof literalNode, LiteralNode>>();
    prove<Equal<typeof literalNode.value, number | boolean | string>>();
    prove<Equal<IsAny<typeof literalNode>, false>>();
    prove<Equal<IsNever<typeof literalNode>, false>>();
    return JSON.stringify(literalNode.value);
  },
  record: (recordNode, recordContext) => {
    prove<Equal<typeof recordContext, JavaScriptContext<Type>>>();
    prove<Equal<IsAny<typeof recordContext>, false>>();
    prove<Equal<IsNever<typeof recordContext>, false>>();
    prove<Equal<typeof recordNode, RecordNode>>();
    prove<Equal<typeof recordNode.fields, readonly RecordField[]>>();
    prove<Equal<IsAny<typeof recordNode>, false>>();
    prove<Equal<IsNever<typeof recordNode>, false>>();
    return recordNode.fields.map((field) => `${field.name}: ${recordContext.expr(field.value, recordContext.depth)}`).join(", ");
  },
});

export const inferred = check(function* () {
  const yielded = yield* pure("ready" as const);
  prove<Equal<typeof yielded, "ready">>();
  prove<Equal<IsAny<typeof yielded>, false>>();
  prove<Equal<IsNever<typeof yielded>, false>>();
  const tuple = yield* sequence([pure("label" as const), pure(42 as const), pure(true as const)]);
  prove<Equal<typeof tuple, ["label", 42, true]>>();
  prove<Equal<IsAny<typeof tuple>, false>>();
  prove<Equal<IsNever<typeof tuple>, false>>();
  return tuple;
});
prove<Equal<typeof inferred, Check<["label", 42, true]>>>();

export const theoryConsumer: Check<readonly [hm.Variable, rows.RowVariable, rank.Variable]> = check(function* () {
  const hmVariable = yield* hm.fresh();
  prove<Equal<typeof hmVariable, hm.Variable>>();
  const rowVariable = yield* rows.freshRow(["label"]);
  prove<Equal<typeof rowVariable, rows.RowVariable>>();
  const rankVariable = yield* rank.fresh(1);
  prove<Equal<typeof rankVariable, rank.Variable>>();
  return [hmVariable, rowVariable, rankVariable] as const;
});

export const namedValue: Value<Type> = language.literal(rows.number, 42);
export const namedCheck: Check<Value<Type>> = pure(namedValue);
