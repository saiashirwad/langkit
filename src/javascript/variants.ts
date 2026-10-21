import { defineJavaScriptBackend } from "../javascript.ts";
import type { VariantDescriptors } from "../operations/variants.ts";

export const variantsJavaScript = <T>(descriptors: VariantDescriptors<T>) => {
  let matchIndex = 0;
  return defineJavaScriptBackend(descriptors, {
    variant: (node, context) =>
      `({ __proto__: null, tag: ${JSON.stringify(node.tag)}, fields: [${
        node.fields.map((field) => context.expr(field, context.depth)).join(", ")
      }] })`,
    match: (node, context) => {
      const temporary = `$match${matchIndex++}`;
      const branches = node.cases.map((branch) => {
        const bindings = branch.bindings
          .map((binding, index) => `const ${context.name(binding)} = ${temporary}.fields[${index}];`)
          .join(" ");
        return `case ${JSON.stringify(branch.tag)}: { ${bindings} return (() => ${
          context.block(branch.body, context.depth + 1)
        })(); }`;
      });
      if (node.fallback) {
        const binding = node.fallback.binding;
        branches.push(
          `default: { ${binding ? `const ${context.name(binding)} = ${temporary};` : ""} return (() => ${
            context.block(node.fallback.body, context.depth + 1)
          })(); }`,
        );
      } else branches.push("default: throw new Error(\"Internal non-exhaustive match\");");
      return `((${temporary}) => { switch (${temporary}.tag) { ${branches.join(" ")} } })(${
        context.expr(node.value, context.depth)
      })`;
    },
  });
};
