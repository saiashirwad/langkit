import type { Binding, Body, OperationNode, OperationValue, OperationTraversal, Value } from "../ir.ts";

export type OperationHandler<Node extends OperationNode, Context, Output> = (node: Node, context: Context) => Output;

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
  return Object.freeze<OperationDescriptor<T, Node>>({
    id,
    kind,
    ...traversal,
    make: (type, node) => ({ type, node, operationId: id }),
    is: (value): value is OperationValue<T, Node> => value.operationId === id,
  });
};

export const traversalOf = <T, Node extends OperationNode>(operation: OperationDescriptor<T, Node>): OperationTraversal<T> => {
  const { id, kind, children, scopedBodies, references, map, validate } = operation;
  return Object.freeze<OperationTraversal<T>>({
    id,
    kind,
    children: node => children.call(operation, node as Node),
    scopedBodies: node => scopedBodies.call(operation, node as Node),
    references: node => references.call(operation, node as Node),
    map: (node, value, body, binding) => map.call(operation, node as Node, value, body, binding),
    ...(validate ? { validate: (node: OperationNode) => validate.call(operation, node as Node) } : {}),
  });
};
