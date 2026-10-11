import { defineDialect } from "../operations/dialect.ts";
import type { RecordDescriptors } from "../operations/records.ts";
import { definePythonBackend } from "./operations.ts";

export const recordsPython = <T>(descriptors: RecordDescriptors<T>) => {
  let tempIndex = 0;
  return definePythonBackend(defineDialect(descriptors), {
    record: (node, context) => {
      const index = tempIndex++;
      const parameters = node.fields.map((_, fieldIndex) => `_py_field_${index}_${fieldIndex}`);
      const values = node.fields.map((field) => context.expr(field.value, context.depth));
      const entries = node.fields.map((field, fieldIndex) =>
        `${JSON.stringify(field.name)}: ${parameters[fieldIndex]}`
      );
      if (node.base) {
        const base = `_py_base_${index}`;
        parameters.push(base);
        values.push(context.expr(node.base, context.depth));
        entries.unshift(`**${base}`);
      }
      return `(lambda ${parameters.join(", ")}: {${entries.join(", ")}})(${values.join(", ")})`;
    },
    merge: (node, context) =>
      `{**(${context.expr(node.left, context.depth)}), **(${context.expr(node.right, context.depth)})}`,
    field: (node, context) => `(${context.expr(node.record, context.depth)})[${JSON.stringify(node.name)}]`,
  });
};
