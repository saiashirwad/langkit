import { type Binding, type Body, type OperationNode, type Program, validate, type Value } from "./ir.ts";
import { createPythonDispatcher, type DispatcherHandler } from "./python/operations.ts";

export type PythonContext<T> = {
  readonly depth: number;
  readonly expr: (value: Value<T>, depth: number) => string;
  readonly block: (body: Body<T>, depth: number) => string;
  readonly name: (binding: Binding<T>) => string;
};

type PythonDispatcher<T> = (operationId: symbol, node: OperationNode, context: PythonContext<T>) => string;

const emitWithDispatcher = <T>(program: Program<T>, dispatch: PythonDispatcher<T>): string => {
  validate(program);
  const names = new Map<symbol, string>();
  const name = (binding: Binding<T>): string => {
    const known = names.get(binding.id);
    if (known) return known;
    const hint = binding.name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^\d/, "_$&") || "binding";
    const chosen = `_v_${hint}_${names.size}`;
    names.set(binding.id, chosen);
    return chosen;
  };
  const block = (body: Body<T>, depth: number): string => {
    const expressions = body.declarations.map(({ binding, value }) =>
      `(${name(binding)} := ${expr(value, depth + 1)})`
    );
    expressions.push(expr(body.result, depth + 1));
    return `(lambda: (${expressions.join(", ")},)[-1])()`;
  };
  const expr = (value: Value<T>, depth: number): string =>
    dispatch(value.operationId, value.node, { expr, block, name, depth });
  return [
    "import math",
    "",
    "def _langkit_div(a, b):",
    "    if b != 0.0:",
    "        return a / b",
    "    if a == 0.0 or math.isnan(a):",
    "        return float('nan')",
    "    return math.copysign(float('inf'), a * math.copysign(1.0, b))",
    "",
    "def _langkit_strict_eq(a, b):",
    "    if isinstance(a, bool) or isinstance(b, bool):",
    "        return isinstance(a, bool) and isinstance(b, bool) and a is b",
    "    if isinstance(a, (int, float)) and isinstance(b, (int, float)):",
    "        return a == b",
    "    if isinstance(a, str) and isinstance(b, str):",
    "        return a == b",
    "    return a is b",
    "",
    "def _langkit_truthy(value):",
    "    if value is None or value is False:",
    "        return False",
    "    if isinstance(value, (int, float)):",
    "        return value != 0 and not math.isnan(value)",
    "    if isinstance(value, str):",
    "        return len(value) != 0",
    "    return True",
    "",
    "def _langkit_non_exhaustive(_value):",
    "    raise RuntimeError('Internal non-exhaustive match')",
    "",
    `result = ${block(program.body, 0)}`,
    "",
  ].join("\n");
};

/** Validates the program, then emits executable Python using identity-matched handlers. */
export const emit = <T>(program: Program<T>, handlers: readonly DispatcherHandler<PythonContext<T>>[] = []): string =>
  emitWithDispatcher(program, createPythonDispatcher(...handlers));

/** Compose backend feature sets; duplicate descriptor handlers are rejected by dispatch. */
export const createPythonEmitter = <T>(...sets: readonly (readonly DispatcherHandler<PythonContext<T>>[])[]) => {
  const dispatch = createPythonDispatcher(...sets.flat());
  return { emit: (program: Program<T>): string => emitWithDispatcher(program, dispatch) };
};
