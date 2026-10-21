import { defineJavaScriptBackend } from "../javascript.ts";
import type { CoreDescriptors } from "../operations/core.ts";

const literal = (value: number | boolean | string): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "(0 / 0)";
  if (value === Infinity) return "(1 / 0)";
  if (value === -Infinity) return "(-1 / 0)";
  return String(value);
};

export const coreJavaScript = <T>(descriptors: CoreDescriptors<T>) =>
  defineJavaScriptBackend(descriptors, {
    literal: (node) => literal(node.value),
    ref: (node, context) => context.name(node.binding),
    binary: (node, context) =>
      `(${context.expr(node.left)} ${node.op === "==" ? "===" : node.op} ${context.expr(node.right)})`,
    call: (node, context) => `(${context.expr(node.fn)})(${context.expr(node.arg)})`,
    fn: (node, context) => `((${context.name(node.param)}) => ${context.block(node.body)})`,
    conditional: (node, context) =>
      `(${context.expr(node.cond)} ? (() => ${context.block(node.then)})() : (() => ${context.block(node.else)})())`,
    block: (node, context) => `(() => ${context.block(node.body)})()`,
  });
