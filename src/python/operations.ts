import type { OperationNode } from "../ir.ts";
import type { PythonContext } from "../python.ts";
import { defineBackend, type BackendHandlers, type DescriptorRecord, type Dialect, type DialectType } from "../operations/dialect.ts";
import type { OperationDescriptor, OperationHandler } from "../operations/descriptor.ts";

export type PythonHandler<T, Node extends OperationNode, Context> = {
  readonly operationId: symbol;
  readonly kind: Node["kind"];
  readonly emit: OperationHandler<Node, Context, string>;
};
export type DispatcherHandler<Context> = {
  readonly operationId: symbol;
  readonly kind: string;
  readonly emit: OperationHandler<OperationNode, Context, string>;
};

export const definePythonHandler = <T, Node extends OperationNode, Context>(
  operation: OperationDescriptor<T, Node>,
  emit: OperationHandler<Node, Context, string>,
): PythonHandler<T, Node, Context> => ({ operationId: operation.id, kind: operation.kind, emit });

export const definePythonBackend = <const D extends DescriptorRecord>(
  dialect: Dialect<D>,
  handlers: BackendHandlers<NoInfer<D>, PythonContext<DialectType<D>>, string>,
): readonly DispatcherHandler<PythonContext<DialectType<D>>>[] => defineBackend<PythonContext<DialectType<D>>>()(dialect, handlers);

export const asDispatcherHandler = <T, Node extends OperationNode, Context>(
  handler: PythonHandler<T, Node, Context>,
): DispatcherHandler<Context> => ({
  operationId: handler.operationId,
  kind: handler.kind,
  emit: (node, context) => handler.emit(node as Node, context),
});

/** Dispatch is descriptor-identity-only; operation-kind collisions never select a handler. */
export const createPythonDispatcher = <Context>(...handlers: readonly DispatcherHandler<Context>[]) => {
  const byId = new Map<symbol, DispatcherHandler<Context>>();
  for (const handler of handlers) {
    if (byId.has(handler.operationId)) throw new Error(`Duplicate Python handler: ${handler.kind}`);
    byId.set(handler.operationId, handler);
  }
  return (operationId: symbol, node: OperationNode, context: Context): string => {
    const handler = byId.get(operationId);
    if (!handler) throw new Error(`Missing Python handler for operation: ${node.kind}`);
    return handler.emit(node, context);
  };
};
