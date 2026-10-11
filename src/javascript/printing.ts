import type { PrintingDescriptors } from "../operations/printing.ts";
import { defineDialect } from "../operations/dialect.ts";
import { defineJavaScriptBackend } from "./operations.ts";

export const printingJavaScript = <T>(descriptors: PrintingDescriptors<T>) => defineJavaScriptBackend(defineDialect(descriptors), {
  print: (node, context) => `(console.log(${context.expr(node.value, context.depth)}), { __proto__: null })`,
});
