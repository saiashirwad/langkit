import type { OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineJavaScriptOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type Field<T> = { readonly name: string; readonly value: Value<T> };
type RecordNode<T> = OperationNode & { readonly kind: "record"; readonly fields: readonly Field<T>[]; readonly base?: Value<T> };
type MergeNode<T> = OperationNode & { readonly kind: "merge"; readonly left: Value<T>; readonly right: Value<T> };
type FieldNode<T> = OperationNode & { readonly kind: "field"; readonly record: Value<T>; readonly name: string };

/** Record handlers must be built from the same locally selected IR feature descriptors. */
export const recordsJavaScript = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<JavaScriptContext<T>>[] => [
  defineJavaScriptOperationHandler<RecordNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "record"), "record", (node, context) => {
    const params = node.fields.map((_, index) => `_field${index}`);
    const args = node.fields.map((field) => context.expr(field.value, context.depth));
    const entries = node.fields.map((field, index) => `[${JSON.stringify(field.name)}]: ${params[index]}`);
    if (node.base) { params.push("_base"); args.push(context.expr(node.base, context.depth)); entries.unshift("..._base"); }
    return `((${params.join(", ")}) => ({ __proto__: null${entries.length ? `, ${entries.join(", ")}` : ""} }))(${args.join(", ")})`;
  }),
  defineJavaScriptOperationHandler<MergeNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "merge"), "merge", (node, context) =>
    `({ __proto__: null, ...(${context.expr(node.left, context.depth)}), ...(${context.expr(node.right, context.depth)}) })`,
  ),
  defineJavaScriptOperationHandler<FieldNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "field"), "field", (node, context) =>
    `(${context.expr(node.record, context.depth)})[${JSON.stringify(node.name)}]`,
  ),
];
