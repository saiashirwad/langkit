import type { Binding, Body, OperationFeature, OperationNode, OperationValue, Operator, Value } from "../ir.ts";
import { defineOperation, traversalOf } from "./descriptor.ts";

type Literal<T> = OperationNode & { readonly kind: "literal"; readonly value: number | boolean | string };
type ReferenceNode<T> = OperationNode & { readonly kind: "ref"; readonly binding: Binding<T> };
type Binary<T> = OperationNode & { readonly kind: "binary"; readonly op: Operator; readonly left: Value<T>; readonly right: Value<T> };
type Call<T> = OperationNode & { readonly kind: "call"; readonly fn: Value<T>; readonly arg: Value<T> };
type FunctionNode<T> = OperationNode & { readonly kind: "fn"; readonly param: Binding<T>; readonly body: Body<T> };
type Conditional<T> = OperationNode & { readonly kind: "if"; readonly cond: Value<T>; readonly then: Body<T>; readonly else: Body<T> };
type Block<T> = OperationNode & { readonly kind: "block"; readonly body: Body<T> };

export type CoreMethods<T> = {
  literal(type: T, value: number | boolean | string): OperationValue<T, Literal<T>>;
  ref(type: T, binding: Binding<T>): OperationValue<T, ReferenceNode<T>>;
  binary(type: T, op: Operator, left: Value<T>, right: Value<T>): OperationValue<T, Binary<T>>;
  call(type: T, fn: Value<T>, arg: Value<T>): OperationValue<T, Call<T>>;
  fn(type: T, param: Binding<T>, body: Body<T>): OperationValue<T, FunctionNode<T>>;
  conditional(type: T, cond: Value<T>, then: Body<T>, otherwise: Body<T>): OperationValue<T, Conditional<T>>;
  block(type: T, body: Body<T>): OperationValue<T, Block<T>>;
};

export type CoreFeature<T> = OperationFeature<T, CoreMethods<T>> & { readonly functionId: symbol; readonly refId: symbol };

/** Small primitive operation set: binding identity is data and all traversal is descriptor-owned. */
export const coreOperations = <T>(): CoreFeature<T> => {
  const literal = defineOperation<T, Literal<T>>("literal", {
    children: () => [], scopedBodies: () => [], references: () => [], map: (node) => node,
  });
  const ref = defineOperation<T, ReferenceNode<T>>("ref", {
    children: () => [], scopedBodies: () => [], references: (node) => [node.binding],
    map: (node, _value, _body, binding) => ({ ...node, binding: binding(node.binding) }),
  });
  const binary = defineOperation<T, Binary<T>>("binary", {
    children: (node) => [node.left, node.right], scopedBodies: () => [], references: () => [],
    map: (node, value) => ({ ...node, left: value(node.left), right: value(node.right) }),
  });
  const call = defineOperation<T, Call<T>>("call", {
    children: (node) => [node.fn, node.arg], scopedBodies: () => [], references: () => [],
    map: (node, value) => ({ ...node, fn: value(node.fn), arg: value(node.arg) }),
  });
  const fn = defineOperation<T, FunctionNode<T>>("fn", {
    children: () => [],
    scopedBodies: (node) => [{ body: node.body, bindings: [node.param] }],
    references: () => [],
    map: (node, _value, body, binding) => ({ ...node, param: binding(node.param), body: body(node.body) }),
  });
  const conditional = defineOperation<T, Conditional<T>>("if", {
    children: (node) => [node.cond],
    scopedBodies: (node) => [{ body: node.then, bindings: [] }, { body: node.else, bindings: [] }],
    references: () => [],
    map: (node, value, body) => ({ ...node, cond: value(node.cond), then: body(node.then), else: body(node.else) }),
  });
  const block = defineOperation<T, Block<T>>("block", {
    children: () => [], scopedBodies: (node) => [{ body: node.body, bindings: [] }], references: () => [],
    map: (node, _value, body) => ({ ...node, body: body(node.body) }),
  });
  return {
    functionId: fn.id,
    refId: ref.id,
    operations: [traversalOf(literal), traversalOf(ref), traversalOf(binary), traversalOf(call), traversalOf(fn), traversalOf(conditional), traversalOf(block)],
    methods: {
      literal: (type, value) => literal.make(type, { kind: "literal", value }),
      ref: (type, binding) => ref.make(type, { kind: "ref", binding }),
      binary: (type, op, left, right) => binary.make(type, { kind: "binary", op, left, right }),
      call: (type, fnValue, arg) => call.make(type, { kind: "call", fn: fnValue, arg }),
      fn: (type, param, body) => fn.make(type, { kind: "fn", param, body }),
      conditional: (type, cond, then, otherwise) => conditional.make(type, { kind: "if", cond, then, else: otherwise }),
      block: (type, body) => block.make(type, { kind: "block", body }),
    },
  };
};
