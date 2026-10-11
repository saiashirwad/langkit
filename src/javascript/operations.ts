import type { OperationNode } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineBackend, type BackendHandlers, type DescriptorRecord, type Dialect, type DialectType } from "../operations/dialect.ts";
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

export const defineJavaScriptBackend = <const D extends DescriptorRecord>(
  dialect: Dialect<D>,
  handlers: BackendHandlers<NoInfer<D>, JavaScriptContext<DialectType<D>>, string>,
): readonly DispatcherHandler<JavaScriptContext<DialectType<D>>>[] => defineBackend<JavaScriptContext<DialectType<D>>>()(dialect, handlers);

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
