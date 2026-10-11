import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, traversalOf } from "./descriptor.ts";

type PrintNode<T> = OperationNode & { readonly kind: "print"; readonly value: Value<T> };
export type PrintingMethods<T> = { print(type: T, printed: Value<T>): Value<T> };

/** Printing is an explicit effect and visits its single value child exactly once. */
export const printing = <T>(): OperationFeature<T, PrintingMethods<T>> => {
  const print = defineOperation<T, PrintNode<T>>("print", {
    children: (node) => [node.value], scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, value: mapValue(node.value) }),
  });
  return {
    operations: [traversalOf(print)],
    methods: { print: (type, printed) => print.make(type, { kind: "print", value: printed }) },
  };
};
