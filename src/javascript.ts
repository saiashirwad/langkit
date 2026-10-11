import { validate, type Binding, type Body, type OperationTraversal, type Value } from "./ir.ts";
import { createJavaScriptDispatcher, type DispatcherHandler } from "./javascript/operations.ts";

export type JavaScriptContext<T> = {
  readonly depth: number;
  readonly expr: (value: Value<T>, depth: number) => string;
  readonly block: (body: Body<T>, depth: number) => string;
  readonly name: (binding: Binding<T>) => string;
};

export type JavaScriptEmitOptions<T> = {
  readonly operations?: readonly OperationTraversal<T>[];
  readonly coreFunctionId?: symbol;
  readonly handlers?: readonly DispatcherHandler<JavaScriptContext<T>>[];
};

/** Validates selected operations, then emits through identity-matched handlers only. */
export const emit = <T>(root: Body<T>, options: JavaScriptEmitOptions<T> = {}): string => {
  const operations = options.operations ?? [];
  validate(root, operations, options.coreFunctionId);
  const dispatch = createJavaScriptDispatcher(...(options.handlers ?? []));
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

/** Compose backend feature sets; duplicate descriptor handlers are rejected by dispatch. */
export const createJavaScriptEmitter = <T>(
  ...sets: readonly (readonly DispatcherHandler<JavaScriptContext<T>>[])[]
) => {
  const handlers = sets.flat();
  return {
    emit: (
      root: Body<T>,
      options: Omit<JavaScriptEmitOptions<T>, "handlers"> = {},
    ): string => emit(root, { ...options, handlers }),
  };
};
