import type { OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, type OperationDescriptor } from "./descriptor.ts";

type PrintNode<T> = OperationNode & { readonly kind: "print"; readonly value: Value<T>; };
export type PrintingMethods<T> = { print(type: T, printed: Value<T>): Value<T>; };

export type PrintingDescriptors<T> = { readonly print: OperationDescriptor<T, PrintNode<T>>; };
export const printing = <T>(): OperationFeature<T, PrintingMethods<T>, PrintingDescriptors<T>> => {
  const print = defineOperation<T, PrintNode<T>>("print", {
    children: (node) => [node.value],
  });
  return {
    descriptors: { print },
    methods: { print: (type, printed) => print.make(type, { kind: "print", value: printed }) },
  };
};
