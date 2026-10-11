import type { CoreDescriptors } from "../operations/core.ts";
import { defineDialect } from "../operations/dialect.ts";
import { definePythonBackend } from "./operations.ts";

const literal = (value: number | boolean | string): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Object.is(value, -0)) return "-0.0";
  if (Number.isNaN(value)) return "float('nan')";
  if (value === Infinity) return "float('inf')";
  if (value === -Infinity) return "float('-inf')";
  const rendered = String(value);
  return /[.eE]/.test(rendered) ? rendered : `${rendered}.0`;
};

export const corePython = <T>(descriptors: CoreDescriptors<T>) =>
  definePythonBackend(defineDialect(descriptors), {
    literal: (node) => literal(node.value),
    ref: (node, context) => context.name(node.binding),
    binary: (node, context) => {
      const left = context.expr(node.left, context.depth);
      const right = context.expr(node.right, context.depth);
      if (node.op === "==") return `_langkit_strict_eq(${left}, ${right})`;
      if (node.op === "/") return `_langkit_div(${left}, ${right})`;
      return `(${left} ${node.op} ${right})`;
    },
    call: (node, context) => `(${context.expr(node.fn, context.depth)})(${context.expr(node.arg, context.depth)})`,
    fn: (node, context) => `(lambda ${context.name(node.param)}: ${context.block(node.body, context.depth)})`,
    conditional: (node, context) =>
      `(${context.block(node.then, context.depth)} if _langkit_truthy(${context.expr(node.cond, context.depth)}) else ${
        context.block(node.else, context.depth)
      })`,
    block: (node, context) => context.block(node.body, context.depth),
  });
