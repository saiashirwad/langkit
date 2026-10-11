import type { FolderDescriptors } from "../operations/folders.ts";
import { defineDialect } from "../operations/dialect.ts";
import { defineJavaScriptBackend } from "./operations.ts";

export const foldersJavaScript = <T>(descriptors: FolderDescriptors<T>) => defineJavaScriptBackend(defineDialect(descriptors), {
  fieldOrder: (node) => JSON.stringify(node.names),
  recordFold: (node, context) => `(($order, $metadata, $record, $initial, $step) => { let $acc = $initial; for (const $key of $order) { $acc = $step($acc)($metadata[$key])($record[$key]); } return $acc; })(${context.expr(node.order, context.depth)}, ${context.expr(node.metadata, context.depth)}, ${context.expr(node.record, context.depth)}, ${context.expr(node.initial, context.depth)}, ${context.expr(node.step, context.depth)})`,
});
