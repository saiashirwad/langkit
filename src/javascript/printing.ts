import type { OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineJavaScriptOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type PrintNode<T> = OperationNode & { readonly kind: "print"; readonly value: Value<T> };
/** Explicit printing handler for the corresponding selected IR descriptor. */
export const printingJavaScript = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<JavaScriptContext<T>>[] => [
  defineJavaScriptOperationHandler<PrintNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "print"), "print", (node, context) =>
    `(console.log(${context.expr(node.value, context.depth)}), { __proto__: null })`,
  ),
];
