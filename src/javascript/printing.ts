import { defineJavaScriptBackend } from "../javascript.ts";
import type { PrintingDescriptors } from "../operations/printing.ts";

export const printingJavaScript = <T>(descriptors: PrintingDescriptors<T>) =>
  defineJavaScriptBackend(descriptors, {
    print: (node, context) => `(console.log(${context.expr(node.value)}), { __proto__: null })`,
  });
