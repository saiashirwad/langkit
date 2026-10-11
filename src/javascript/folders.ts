import type { OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineJavaScriptOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type OrderNode = OperationNode & { readonly kind: "field-order"; readonly names: readonly string[] };
type FoldNode<T> = OperationNode & { readonly kind: "record-fold"; readonly order: Value<T>; readonly metadata: Value<T>; readonly record: Value<T>; readonly initial: Value<T>; readonly step: Value<T> };
/** Ordered folds use the explicitly selected folder traversal/handler pair. */
export const foldersJavaScript = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<JavaScriptContext<T>>[] => [
  defineJavaScriptOperationHandler<OrderNode, JavaScriptContext<T>>(operationIdFor(operations, "field-order"), "field-order", (node) => JSON.stringify(node.names)),
  defineJavaScriptOperationHandler<FoldNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "record-fold"), "record-fold", (node, context) =>
    `(($order, $metadata, $record, $initial, $step) => { let $acc = $initial; for (const $key of $order) { $acc = $step($acc)($metadata[$key])($record[$key]); } return $acc; })(${context.expr(node.order, context.depth)}, ${context.expr(node.metadata, context.depth)}, ${context.expr(node.record, context.depth)}, ${context.expr(node.initial, context.depth)}, ${context.expr(node.step, context.depth)})`,
  ),
];
