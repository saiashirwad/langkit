import type { Binding, Body, OperationNode, OperationValue, OperationTraversal, Value } from "../ir.ts";

export type OperationHandler<Node extends OperationNode, Context, Output> = (node: Node, context: Context) => Output;

/**
 * Typed descriptor contract: child order is evaluation order; scoped bodies declare bindings;
 * references expose uses; map reconstructs immutable inspectable data. Recursion policy remains
 * in core and cannot be opted into by an arbitrary extension operation.
 */
export type ScopedBody<B, Bnd> = { readonly body: B; readonly bindings: readonly Bnd[] };
export type OperationDescriptor<T, Node extends OperationNode> = {
  readonly id: symbol;
  readonly kind: Node["kind"];
  readonly children: (node: Node) => readonly Value<T>[];
  readonly scopedBodies: (node: Node) => readonly ScopedBody<Body<T>, Binding<T>>[];
  readonly references: (node: Node) => readonly Binding<T>[];
  readonly map: (node: Node, value: (child: Value<T>) => Value<T>, body: (child: Body<T>) => Body<T>, binding: (binding: Binding<T>) => Binding<T>) => Node;
  readonly validate?: (node: Node) => void;
  readonly make: (type: T, node: Node) => OperationValue<T, Node>;
  readonly is: (value: Value<T>) => value is OperationValue<T, Node>;
};

export const defineOperation = <T, Node extends OperationNode>(
  kind: Node["kind"],
  traversal: {
    readonly children: (node: Node) => readonly Value<T>[];
    readonly scopedBodies: (node: Node) => readonly ScopedBody<Body<T>, Binding<T>>[];
    readonly references: (node: Node) => readonly Binding<T>[];
    readonly map: (node: Node, value: (child: Value<T>) => Value<T>, body: (child: Body<T>) => Body<T>, binding: (binding: Binding<T>) => Binding<T>) => Node;
    readonly validate?: (node: Node) => void;
  },
): OperationDescriptor<T, Node> => {
  const id = Symbol(kind);
  return {
    id,
    kind,
    ...traversal,
    make: (type, node) => ({ type, node, operationId: id }),
    is: (value): value is OperationValue<T, Node> => value.operationId === id,
  };
};

/** Narrow internal erasure at heterogeneous traversal boundaries only. */
export const traversalOf = <T, Node extends OperationNode>(operation: OperationDescriptor<T, Node>): OperationTraversal<T> => ({
  id: operation.id,
  kind: operation.kind,
  children: (node) => operation.children(node as Node),
  scopedBodies: (node) => operation.scopedBodies(node as Node),
  references: (node) => operation.references(node as Node),
  map: (node, value, body, binding) => operation.map(node as Node, value, body, binding),
  ...(operation.validate ? { validate: (node) => operation.validate!(node as Node) } : {}),
});
