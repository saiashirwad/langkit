import type { Binding, Body, OperationNode, OperationValue, Value } from "../ir.ts";

export type ScopedBody<T> = { readonly body: Body<T>; readonly bindings: readonly Binding<T>[]; };

export type Traversal<T, Node extends OperationNode> = {
  readonly children: (node: Node) => readonly Value<T>[];
  readonly scopedBodies: (node: Node) => readonly ScopedBody<T>[];
  readonly references: (node: Node) => readonly Binding<T>[];
  readonly validate?: (node: Node) => void;
};

export type OperationDescriptor<T, Node extends OperationNode> = Traversal<T, Node> & {
  readonly id: symbol;
  readonly kind: Node["kind"];
  readonly make: (type: T, node: Node) => OperationValue<T, Node>;
  readonly is: (value: Value<T>) => value is OperationValue<T, Node>;
};

export type DescriptorRecord = { readonly [key: string]: { readonly id: symbol; readonly kind: string; }; };
export type DescriptorNode<D> = D extends OperationDescriptor<infer _T, infer Node> ? Node : never;
type TypeOf<D> = D extends OperationDescriptor<infer T, infer _Node> ? T : never;
export type DescriptorType<D extends DescriptorRecord> = TypeOf<D[keyof D]>;

const none = () => [];

/** Children, scoped bodies, and references default to none. */
export const defineOperation = <T, Node extends OperationNode>(
  kind: Node["kind"],
  traversal: Partial<Traversal<T, Node>> = {},
): OperationDescriptor<T, Node> => {
  const id = Symbol(kind);
  return Object.freeze({
    id,
    kind,
    children: none,
    scopedBodies: none,
    references: none,
    ...traversal,
    make: (type: T, node: Node) => ({ type, node, operationId: id }),
    is: (value: Value<T>): value is OperationValue<T, Node> => value.operationId === id,
  });
};
