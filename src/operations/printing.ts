import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, type OperationDescriptor } from "./descriptor.ts";
import { defineDialect } from "./dialect.ts";

type PrintNode<T> = OperationNode & { readonly kind: "print"; readonly value: Value<T> };
export type PrintingMethods<T> = { print(type: T, printed: Value<T>): Value<T> };

/** Printing is an explicit effect and visits its single value child exactly once. */
export type PrintingDescriptors<T> = { readonly print: OperationDescriptor<T, PrintNode<T>> };
export const printing = <T>(): OperationFeature<T, PrintingMethods<T>, PrintingDescriptors<T>> => {
  const print = defineOperation<T, PrintNode<T>>("print", {
    children: (node) => [node.value], scopedBodies: () => [], references: () => [],
    map: (node, mapValue) => ({ ...node, value: mapValue(node.value) }),
  });
  return {
    ...defineDialect({ print }),
    methods: { print: (type, printed) => print.make(type, { kind: "print", value: printed }) },
  };
};
