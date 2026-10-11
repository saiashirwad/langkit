import type { Binding, MatchCase, MatchFallback, OperationNode, OperationTraversal, Value } from "../ir.ts";
import type { JavaScriptContext } from "../javascript.ts";
import { defineJavaScriptOperationHandler, operationIdFor, type DispatcherHandler } from "./operations.ts";

type VariantNode<T> = OperationNode & { readonly kind: "variant"; readonly tag: string; readonly fields: readonly Value<T>[] };
type MatchNode<T> = OperationNode & { readonly kind: "match"; readonly value: Value<T>; readonly cases: readonly MatchCase<T>[]; readonly fallback?: MatchFallback<T> };

/** Match handlers are tied to their selected IR descriptor, never matched by a global kind. */
export const variantsJavaScript = <T>(operations: readonly OperationTraversal<T>[]): readonly DispatcherHandler<JavaScriptContext<T>>[] => {
  let matchIndex = 0;
  return [
    defineJavaScriptOperationHandler<VariantNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "variant"), "variant", (node, context) =>
      `({ __proto__: null, tag: ${JSON.stringify(node.tag)}, fields: [${node.fields.map((field) => context.expr(field, context.depth)).join(", ")}] })`,
    ),
    defineJavaScriptOperationHandler<MatchNode<T>, JavaScriptContext<T>>(operationIdFor(operations, "match"), "match", (node, context) => {
      const temporary = `$match${matchIndex++}`;
      const branches = node.cases.map((branch) => {
        const bindings = branch.bindings
          .map((binding: Binding<T>, index) => `const ${context.name(binding)} = ${temporary}.fields[${index}];`)
          .join(" ");
        return `case ${JSON.stringify(branch.tag)}: { ${bindings} return (() => ${context.block(branch.body, context.depth + 1)})(); }`;
      });
      if (node.fallback) {
        const binding = node.fallback.binding;
        branches.push(`default: { ${binding ? `const ${context.name(binding)} = ${temporary};` : ""} return (() => ${context.block(node.fallback.body, context.depth + 1)})(); }`);
      } else branches.push('default: throw new Error("Internal non-exhaustive match");');
      return `((${temporary}) => { switch (${temporary}.tag) { ${branches.join(" ")} } })(${context.expr(node.value, context.depth)})`;
    }),
  ];
};
