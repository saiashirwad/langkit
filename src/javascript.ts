import { type Binding, type Body, type OperationNode, type Program, validate, type Value } from "./ir.ts";
import { createJavaScriptDispatcher, type DispatcherHandler } from "./javascript/operations.ts";

export type JavaScriptContext<T> = {
  readonly depth: number;
  readonly expr: (value: Value<T>, depth: number) => string;
  readonly block: (body: Body<T>, depth: number) => string;
  readonly name: (binding: Binding<T>) => string;
};

const noHandlers: readonly [] = [];
type JavaScriptDispatcher<T> = (operationId: symbol, node: OperationNode, context: JavaScriptContext<T>) => string;

const emitWithDispatcher = <T>(program: Program<T>, dispatch: JavaScriptDispatcher<T>): string => {
  const root = program.body;
  validate(program);
  const names = new Map<symbol, string>();
  const name = (binding: Binding<T>): string => {
    const known = names.get(binding.id);
    if (known) return known;
    const hint = binding.name.replace(/[^a-zA-Z0-9_]/g, "_");
    const chosen = `_${hint}_${names.size}`;
    names.set(binding.id, chosen);
    return chosen;
  };
  const block = (body: Body<T>, depth: number): string => {
    const indent = "  ".repeat(depth + 1);
    return [
      "{",
      ...body.declarations.map(({ binding, value }) => `${indent}const ${name(binding)} = ${expr(value, depth + 1)};`),
      `${indent}return ${expr(body.result, depth + 1)};`,
      `${"  ".repeat(depth)}}`,
    ].join("\n");
  };
  const expr = (value: Value<T>, depth: number): string =>
    dispatch(value.operationId, value.node, { expr, block, name, depth });
  return `(() => ${block(root, 0)})()\n`;
};

/** Validates selected operations, then emits through identity-matched handlers only. */
export const emit = <T>(
  program: Program<T>,
  handlers: readonly DispatcherHandler<JavaScriptContext<T>>[] = noHandlers,
): string => emitWithDispatcher(program, createJavaScriptDispatcher(...handlers));

/** Compose backend feature sets; duplicate descriptor handlers are rejected by dispatch. */
export const createJavaScriptEmitter = <T>(
  ...sets: readonly (readonly DispatcherHandler<JavaScriptContext<T>>[])[]
) => {
  const dispatch = createJavaScriptDispatcher(...sets.flat());
  return {
    emit: (program: Program<T>): string => emitWithDispatcher(program, dispatch),
  };
};
