import { defineJavaScriptBackend } from "../javascript.ts";
import type { VariantDescriptors } from "../operations/variants.ts";

export const variantsJavaScript = <T>(descriptors: VariantDescriptors<T>) =>
  defineJavaScriptBackend(descriptors, {
    variant: (node, context) =>
      `({ __proto__: null, tag: ${JSON.stringify(node.tag)}, fields: [${
        node.fields.map((field) => context.expr(field)).join(", ")
      }] })`,
    match: (node, context) => {
      const temporary = context.fresh("match");
      const branches = node.cases.map((branch) => {
        const bindings = branch.bindings
          .map((binding, index) => `const ${context.name(binding)} = ${temporary}.fields[${index}];`)
          .join(" ");
        return `case ${JSON.stringify(branch.tag)}: { ${bindings} return ${context.iife(branch.body, 1)}; }`;
      });
      if (node.fallback) {
        const binding = node.fallback.binding;
        branches.push(
          `default: { ${binding ? `const ${context.name(binding)} = ${temporary};` : ""} return ${
            context.iife(node.fallback.body, 1)
          }; }`,
        );
      } else branches.push("default: throw new Error(\"Internal non-exhaustive match\");");
      return `((${temporary}) => { switch (${temporary}.tag) { ${branches.join(" ")} } })(${context.expr(node.value)})`;
    },
  });
