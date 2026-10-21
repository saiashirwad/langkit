import { defineJavaScriptBackend } from "../javascript.ts";
import type { RecordDescriptors } from "../operations/records.ts";

export const recordsJavaScript = <T>(descriptors: RecordDescriptors<T>) =>
  defineJavaScriptBackend(descriptors, {
    record: (node, context) => {
      const params = node.fields.map((_, index) => `_field${index}`);
      const args = node.fields.map((field) => context.expr(field.value, context.depth));
      const entries = node.fields.map((field, index) => `[${JSON.stringify(field.name)}]: ${params[index]}`);
      if (node.base) {
        params.push("_base");
        args.push(context.expr(node.base, context.depth));
        entries.unshift("..._base");
      }
      return `((${params.join(", ")}) => ({ __proto__: null${entries.length ? `, ${entries.join(", ")}` : ""} }))(${
        args.join(", ")
      })`;
    },
    merge: (node, context) =>
      `({ __proto__: null, ...(${context.expr(node.left, context.depth)}), ...(${
        context.expr(node.right, context.depth)
      }) })`,
    field: (node, context) => `(${context.expr(node.record, context.depth)})[${JSON.stringify(node.name)}]`,
  });
