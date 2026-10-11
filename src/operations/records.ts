import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, traversalOf } from "./descriptor.ts";

type RecordField<T> = { readonly name: string; readonly value: Value<T> };
type RecordNode<T> = OperationNode & { readonly kind: "record"; readonly fields: readonly RecordField<T>[]; readonly base?: Value<T> };
type MergeNode<T> = OperationNode & { readonly kind: "merge"; readonly left: Value<T>; readonly right: Value<T> };
type FieldNode<T> = OperationNode & { readonly kind: "field"; readonly record: Value<T>; readonly name: string };
export type RecordMethods<T> = {
  record(type: T, fields: readonly RecordField<T>[], base?: Value<T>): Value<T>;
  merge(type: T, left: Value<T>, right: Value<T>): Value<T>;
  field(type: T, record: Value<T>, name: string): Value<T>;
};

/** Record evaluation is source-ordered fields followed by the optional base. */
export const records = <T>(): OperationFeature<T, RecordMethods<T>> => {
  const record = defineOperation<T, RecordNode<T>>("record", {
    children: (node) => [...node.fields.map(({ value }) => value), ...(node.base ? [node.base] : [])],
    scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, fields: node.fields.map((field) => ({ ...field, value: mapValue(field.value) })), ...(node.base ? { base: mapValue(node.base) } : {}) }),
  });
  const merge = defineOperation<T, MergeNode<T>>("merge", {
    children: (node) => [node.left, node.right], scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, left: mapValue(node.left), right: mapValue(node.right) }),
  });
  const field = defineOperation<T, FieldNode<T>>("field", {
    children: (node) => [node.record], scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, record: mapValue(node.record) }),
  });
  return {
    operations: [traversalOf(record), traversalOf(merge), traversalOf(field)],
    methods: {
      record: (type, fields, base) => record.make(type, base ? { kind: "record", fields, base } : { kind: "record", fields }),
      merge: (type, left, right) => merge.make(type, { kind: "merge", left, right }),
      field: (type, recordValue, name) => field.make(type, { kind: "field", record: recordValue, name }),
    },
  };
};
