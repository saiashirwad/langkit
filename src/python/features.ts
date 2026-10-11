import type { Binding, MatchCase, MatchFallback, OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { PythonContext } from "../python.ts";
import { definePythonOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type VariantNode<T> = OperationNode & { readonly kind: "variant"; readonly tag: string; readonly fields: readonly Value<T>[] };
type MatchNode<T> = OperationNode & { readonly kind: "match"; readonly value: Value<T>; readonly cases: readonly MatchCase<T>[]; readonly fallback?: MatchFallback<T> };
type PrintNode<T> = OperationNode & { readonly kind: "print"; readonly value: Value<T> };
type OrderNode = OperationNode & { readonly kind: "field-order"; readonly names: readonly string[] };
type FoldNode<T> = OperationNode & { readonly kind: "record-fold"; readonly order: Value<T>; readonly metadata: Value<T>; readonly record: Value<T>; readonly initial: Value<T>; readonly step: Value<T> };

export const variantsPython = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<PythonContext<T>>[] => {
  let matchIndex = 0;
  return [
    definePythonOperationHandler<VariantNode<T>, PythonContext<T>>(operationIdFor(operations, "variant"), "variant", (node, context) =>
      `{"tag": ${JSON.stringify(node.tag)}, "fields": [${node.fields.map((field) => context.expr(field, context.depth)).join(", ")}]}`,
    ),
    definePythonOperationHandler<MatchNode<T>, PythonContext<T>>(operationIdFor(operations, "match"), "match", (node, context) => {
      const matched = `_py_match_${matchIndex++}`;
      const cases = node.cases.map((branch) => {
        const bindings = branch.bindings.map((binding: Binding<T>) => context.name(binding));
        const arguments_ = bindings.map((_, index) => `${matched}["fields"][${index}] if len(${matched}["fields"]) > ${index} else None`);
        const result = context.block(branch.body, context.depth + 1);
        const body = bindings.length
          ? `(lambda ${bindings.join(", ")}: ${result})(${arguments_.join(", ")})`
          : result;
        return { tag: branch.tag, body };
      });
      const alternative = node.fallback
        ? node.fallback.binding
          ? `(lambda ${context.name(node.fallback.binding)}: ${context.block(node.fallback.body, context.depth + 1)})(${matched})`
          : context.block(node.fallback.body, context.depth + 1)
        : `_langkit_non_exhaustive(${matched})`;
      let result = alternative;
      for (const branch of [...cases].reverse()) {
        result = `(${branch.body} if ${matched}["tag"] == ${JSON.stringify(branch.tag)} else ${result})`;
      }
      return `(lambda ${matched}: ${result})(${context.expr(node.value, context.depth)})`;
    }),
  ];
};

export const printingPython = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<PythonContext<T>>[] => [
  definePythonOperationHandler<PrintNode<T>, PythonContext<T>>(operationIdFor(operations, "print"), "print", (node, context) =>
    `(print(${context.expr(node.value, context.depth)}), {})[-1]`,
  ),
];

export const foldersPython = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<PythonContext<T>>[] => [
  definePythonOperationHandler<OrderNode, PythonContext<T>>(operationIdFor(operations, "field-order"), "field-order", (node) => JSON.stringify(node.names)),
  definePythonOperationHandler<FoldNode<T>, PythonContext<T>>(operationIdFor(operations, "record-fold"), "record-fold", (node, context) => {
    const order = context.expr(node.order, context.depth);
    const metadata = context.expr(node.metadata, context.depth);
    const record = context.expr(node.record, context.depth);
    const initial = context.expr(node.initial, context.depth);
    const step = context.expr(node.step, context.depth);
    return `(lambda _py_order, _py_metadata, _py_record, _py_initial, _py_step: __import__("functools").reduce(lambda _py_acc, _py_key: _py_step(_py_acc)(_py_metadata[_py_key])(_py_record[_py_key]), _py_order, _py_initial))(${order}, ${metadata}, ${record}, ${initial}, ${step})`;
  }),
];
