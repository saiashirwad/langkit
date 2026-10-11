import type { Binding, Body, OperationNode, OperationTraversal, Operator, Value } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineJavaScriptOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type LiteralNode = OperationNode & { readonly kind: "literal"; readonly value: number | boolean | string };
type ReferenceNode<T> = OperationNode & { readonly kind: "ref"; readonly binding: Binding<T> };
type BinaryNode<T> = OperationNode & { readonly kind: "binary"; readonly op: Operator; readonly left: Value<T>; readonly right: Value<T> };
type CallNode<T> = OperationNode & { readonly kind: "call"; readonly fn: Value<T>; readonly arg: Value<T> };
type FunctionNode<T> = OperationNode & { readonly kind: "fn"; readonly param: Binding<T>; readonly body: Body<T> };
type ConditionalNode<T> = OperationNode & { readonly kind: "if"; readonly cond: Value<T>; readonly then: Body<T>; readonly else: Body<T> };
type BlockNode<T> = OperationNode & { readonly kind: "block"; readonly body: Body<T> };

const literal = (value: number | boolean | string): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "(0 / 0)";
  if (value === Infinity) return "(1 / 0)";
  if (value === -Infinity) return "(-1 / 0)";
  return String(value);
};

/** Core JavaScript implementations match only the core descriptor identities supplied here. */
export const coreJavaScript = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<JavaScriptContext<T>>[] => [
  defineJavaScriptOperationHandler<LiteralNode, JavaScriptContext<T>>(operationIdFor(operations, "literal"), "literal", (node) => literal(node.value)),
  defineJavaScriptOperationHandler<ReferenceNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "ref"), "ref", (node, context) => context.name(node.binding)),
  defineJavaScriptOperationHandler<BinaryNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "binary"), "binary", (node, context) =>
    `(${context.expr(node.left, context.depth)} ${node.op === "==" ? "===" : node.op} ${context.expr(node.right, context.depth)})`,
  ),
  defineJavaScriptOperationHandler<CallNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "call"), "call", (node, context) =>
    `(${context.expr(node.fn, context.depth)})(${context.expr(node.arg, context.depth)})`,
  ),
  defineJavaScriptOperationHandler<FunctionNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "fn"), "fn", (node, context) =>
    `((${context.name(node.param)}) => ${context.block(node.body, context.depth)})`,
  ),
  defineJavaScriptOperationHandler<ConditionalNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "if"), "if", (node, context) =>
    `(${context.expr(node.cond, context.depth)} ? (() => ${context.block(node.then, context.depth)})() : (() => ${context.block(node.else, context.depth)})())`,
  ),
  defineJavaScriptOperationHandler<BlockNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "block"), "block", (node, context) =>
    `(() => ${context.block(node.body, context.depth)})()`,
  ),
];
