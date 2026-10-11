import type { OperationNode, OperationTraversal } from "../ir.ts";
import type { OperationDescriptor, OperationHandler } from "../operations/descriptor.ts";

export type JavaScriptHandler<T, Node extends OperationNode, Context> = {
  readonly operationId: symbol;
  readonly kind: Node["kind"];
  readonly emit: OperationHandler<Node, Context, string>;
};
export type DispatcherHandler<Context> = {
  readonly operationId: symbol;
  readonly kind: string;
  readonly emit: OperationHandler<OperationNode, Context, string>;
};

export const defineJavaScriptHandler = <T, Node extends OperationNode, Context>(
  operation: OperationDescriptor<T, Node>,
  emit: OperationHandler<Node, Context, string>,
): JavaScriptHandler<T, Node, Context> => ({ operationId: operation.id, kind: operation.kind, emit });

/** Use when a feature exposes its structural descriptors instead of typed descriptor objects. */
export const defineJavaScriptOperationHandler = <Node extends OperationNode, Context>(
  operationId: symbol,
  kind: Node["kind"],
  emit: OperationHandler<Node, Context, string>,
): DispatcherHandler<Context> => ({ operationId, kind, emit: (node, context) => emit(node as Node, context) });

/** Resolve a backend handler against the exact IR feature instances selected by the caller. */
export const operationIdFor = <T>(operations: readonly OperationTraversal<T>[], kind: string): symbol => {
  const matches = operations.filter((operation) => operation.kind === kind);
  if (matches.length !== 1) throw new Error(`Expected one selected IR operation named ${kind}; found ${matches.length}`);
  return matches[0]!.id;
};

/** Narrow internal erasure at the heterogeneous backend handler-list boundary. */
export const asDispatcherHandler = <T, Node extends OperationNode, Context>(
  handler: JavaScriptHandler<T, Node, Context>,
): DispatcherHandler<Context> => ({
  operationId: handler.operationId,
  kind: handler.kind,
  emit: (node, context) => handler.emit(node as Node, context),
});

/** Backend dispatch is descriptor-identity-only; kind collisions never select a handler. */
export const createJavaScriptDispatcher = <Context>(...handlers: readonly DispatcherHandler<Context>[]) => {
  const byId = new Map<symbol, DispatcherHandler<Context>>();
  for (const handler of handlers) {
    if (byId.has(handler.operationId)) throw new Error(`Duplicate JavaScript handler: ${handler.kind}`);
    byId.set(handler.operationId, handler);
  }
  return (operationId: symbol, node: OperationNode, context: Context): string => {
    const handler = byId.get(operationId);
    if (!handler) throw new Error(`Missing JavaScript handler for operation: ${node.kind}`);
    return handler.emit(node, context);
  };
};
