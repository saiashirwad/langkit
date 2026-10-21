import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, type OperationDescriptor } from "./descriptor.ts";

type RecordField<T> = { readonly name: string; readonly value: Value<T>; };
type RecordNode<T> = OperationNode & {
  readonly kind: "record";
  readonly fields: readonly RecordField<T>[];
  readonly base?: Value<T>;
};
type FieldNode<T> = OperationNode & { readonly kind: "field"; readonly record: Value<T>; readonly name: string; };
export type RecordMethods<T> = {
  record(type: T, fields: readonly RecordField<T>[], base?: Value<T>): Value<T>;
  field(type: T, record: Value<T>, name: string): Value<T>;
};

export type RecordDescriptors<T> = {
  readonly record: OperationDescriptor<T, RecordNode<T>>;
  readonly field: OperationDescriptor<T, FieldNode<T>>;
};

export const records = <T>(): OperationFeature<T, RecordMethods<T>, RecordDescriptors<T>> => {
  const record = defineOperation<T, RecordNode<T>>("record", {
    children: (node) => [...node.fields.map(({ value }) => value), ...(node.base ? [node.base] : [])],
  });
  const field = defineOperation<T, FieldNode<T>>("field", { children: (node) => [node.record] });
  return {
    descriptors: { record, field },
    methods: {
      record: (type, fields, base) =>
        record.make(type, base ? { kind: "record", fields, base } : { kind: "record", fields }),
      field: (type, recordValue, name) => field.make(type, { kind: "field", record: recordValue, name }),
    },
  };
};
