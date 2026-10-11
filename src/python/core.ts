import type { Binding, Body, OperationNode, OperationTraversal, Operator, Value } from "../ir.ts";
import type { PythonContext } from "../python.ts";
import { definePythonOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type LiteralNode = OperationNode & { readonly kind: "literal"; readonly value: number | boolean | string };
type ReferenceNode<T> = OperationNode & { readonly kind: "ref"; readonly binding: Binding<T> };
type BinaryNode<T> = OperationNode & { readonly kind: "binary"; readonly op: Operator; readonly left: Value<T>; readonly right: Value<T> };
type CallNode<T> = OperationNode & { readonly kind: "call"; readonly fn: Value<T>; readonly arg: Value<T> };
type FunctionNode<T> = OperationNode & { readonly kind: "fn"; readonly param: Binding<T>; readonly body: Body<T> };
type ConditionalNode<T> = OperationNode & { readonly kind: "if"; readonly cond: Value<T>; readonly then: Body<T>; readonly else: Body<T> };
type BlockNode<T> = OperationNode & { readonly kind: "block"; readonly body: Body<T> };

const literal = (value: number | boolean | string): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isNaN(value)) return "float('nan')";
  if (value === Infinity) return "float('inf')";
  if (value === -Infinity) return "float('-inf')";
  const rendered = String(value);
  return /[.eE]/.test(rendered) ? rendered : `${rendered}.0`;
};

export const corePython = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<PythonContext<T>>[] => [
  definePythonOperationHandler<LiteralNode, PythonContext<T>>(operationIdFor(operations, "literal"), "literal", (node) => literal(node.value)),
  definePythonOperationHandler<ReferenceNode<T>, PythonContext<T>>(operationIdFor(operations, "ref"), "ref", (node, context) => context.name(node.binding)),
  definePythonOperationHandler<BinaryNode<T>, PythonContext<T>>(operationIdFor(operations, "binary"), "binary", (node, context) => {
    const left = context.expr(node.left, context.depth);
    const right = context.expr(node.right, context.depth);
    if (node.op === "==") return `_langkit_strict_eq(${left}, ${right})`;
    if (node.op === "/") return `_langkit_div(${left}, ${right})`;
    return `(${left} ${node.op} ${right})`;
  }),
  definePythonOperationHandler<CallNode<T>, PythonContext<T>>(operationIdFor(operations, "call"), "call", (node, context) =>
    `(${context.expr(node.fn, context.depth)})(${context.expr(node.arg, context.depth)})`,
  ),
  definePythonOperationHandler<FunctionNode<T>, PythonContext<T>>(operationIdFor(operations, "fn"), "fn", (node, context) =>
    `(lambda ${context.name(node.param)}: ${context.block(node.body, context.depth)})`,
  ),
  definePythonOperationHandler<ConditionalNode<T>, PythonContext<T>>(operationIdFor(operations, "if"), "if", (node, context) =>
    `(${context.block(node.then, context.depth)} if _langkit_truthy(${context.expr(node.cond, context.depth)}) else ${context.block(node.else, context.depth)})`,
  ),
  definePythonOperationHandler<BlockNode<T>, PythonContext<T>>(operationIdFor(operations, "block"), "block", (node, context) => context.block(node.body, context.depth)),
];
