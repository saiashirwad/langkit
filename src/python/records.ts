import type { OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { PythonContext } from "../python.ts";
import { definePythonOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type Field<T> = { readonly name: string; readonly value: Value<T> };
type RecordNode<T> = OperationNode & { readonly kind: "record"; readonly fields: readonly Field<T>[]; readonly base?: Value<T> };
type MergeNode<T> = OperationNode & { readonly kind: "merge"; readonly left: Value<T>; readonly right: Value<T> };
type FieldNode<T> = OperationNode & { readonly kind: "field"; readonly record: Value<T>; readonly name: string };

export const recordsPython = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<PythonContext<T>>[] => {
  let tempIndex = 0;
  return [
    definePythonOperationHandler<RecordNode<T>, PythonContext<T>>(operationIdFor(operations, "record"), "record", (node, context) => {
      const index = tempIndex++;
      const parameters = node.fields.map((_, fieldIndex) => `_py_field_${index}_${fieldIndex}`);
      const values = node.fields.map((field) => context.expr(field.value, context.depth));
      const entries = node.fields.map((field, fieldIndex) => `${JSON.stringify(field.name)}: ${parameters[fieldIndex]}`);
      if (node.base) {
        const base = `_py_base_${index}`;
        parameters.push(base);
        values.push(context.expr(node.base, context.depth));
        entries.unshift(`**${base}`);
      }
      return `(lambda ${parameters.join(", ")}: {${entries.join(", ")}})(${values.join(", ")})`;
    }),
    definePythonOperationHandler<MergeNode<T>, PythonContext<T>>(operationIdFor(operations, "merge"), "merge", (node, context) =>
      `{**(${context.expr(node.left, context.depth)}), **(${context.expr(node.right, context.depth)})}`,
    ),
    definePythonOperationHandler<FieldNode<T>, PythonContext<T>>(operationIdFor(operations, "field"), "field", (node, context) =>
      `(${context.expr(node.record, context.depth)})[${JSON.stringify(node.name)}]`,
    ),
  ];
};
