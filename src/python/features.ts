import type { VariantDescriptors } from "../operations/variants.ts";
import type { PrintingDescriptors } from "../operations/printing.ts";
import type { FolderDescriptors } from "../operations/folders.ts";
import { defineDialect } from "../operations/dialect.ts";
import { definePythonBackend } from "./operations.ts";

export const variantsPython = <T>(descriptors: VariantDescriptors<T>) => {
  let matchIndex = 0;
  return definePythonBackend(defineDialect(descriptors), {
    variant: (node, context) => `{"tag": ${JSON.stringify(node.tag)}, "fields": [${node.fields.map((field) => context.expr(field, context.depth)).join(", ")}]}`,
    match: (node, context) => {
      const matched = `_py_match_${matchIndex++}`;
      const cases = node.cases.map((branch) => {
        const bindings = branch.bindings.map((binding) => context.name(binding));
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
    },
  });
};

export const printingPython = <T>(descriptors: PrintingDescriptors<T>) => definePythonBackend(defineDialect(descriptors), {
  print: (node, context) => `(print(${context.expr(node.value, context.depth)}), {})[-1]`,
});

export const foldersPython = <T>(descriptors: FolderDescriptors<T>) => definePythonBackend(defineDialect(descriptors), {
  fieldOrder: (node) => JSON.stringify(node.names),
  recordFold: (node, context) => {
    const order = context.expr(node.order, context.depth);
    const metadata = context.expr(node.metadata, context.depth);
    const record = context.expr(node.record, context.depth);
    const initial = context.expr(node.initial, context.depth);
    const step = context.expr(node.step, context.depth);
    return `(lambda _py_order, _py_metadata, _py_record, _py_initial, _py_step: __import__("functools").reduce(lambda _py_acc, _py_key: _py_step(_py_acc)(_py_metadata[_py_key])(_py_record[_py_key]), _py_order, _py_initial))(${order}, ${metadata}, ${record}, ${initial}, ${step})`;
  },
});
