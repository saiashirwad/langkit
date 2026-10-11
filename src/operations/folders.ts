import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, traversalOf } from "./descriptor.ts";

type OrderNode = OperationNode & { readonly kind: "field-order"; readonly names: readonly string[] };
type FoldNode<T> = OperationNode & { readonly kind: "record-fold"; readonly order: Value<T>; readonly metadata: Value<T>; readonly record: Value<T>; readonly initial: Value<T>; readonly step: Value<T> };
export type FolderMethods<T> = {
  fieldOrder(type: T, names: readonly string[]): Value<T>;
  recordFold(type: T, order: Value<T>, metadata: Value<T>, record: Value<T>, initial: Value<T>, step: Value<T>): Value<T>;
};

/** Folds traverse explicit order, metadata, record, initial, and step left-to-right. */
export const folders = <T>(): OperationFeature<T, FolderMethods<T>> => {
  const order = defineOperation<T, OrderNode>("field-order", {
    children: () => [], scopedBodies: () => [], references: () => [], map: (node) => node,
  });
  const fold = defineOperation<T, FoldNode<T>>("record-fold", {
    children: (node) => [node.order, node.metadata, node.record, node.initial, node.step],
    scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, order: mapValue(node.order), metadata: mapValue(node.metadata), record: mapValue(node.record), initial: mapValue(node.initial), step: mapValue(node.step) }),
  });
  return {
    operations: [traversalOf(order), traversalOf(fold)],
    methods: {
      fieldOrder: (type, names) => order.make(type, { kind: "field-order", names }),
      recordFold: (type, orderValue, metadata, record, initial, step) => fold.make(type, { kind: "record-fold", order: orderValue, metadata, record, initial, step }),
    },
  };
};
