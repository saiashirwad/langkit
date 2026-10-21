import { type Binding, type Body, type OperationNode, type Program, validate, type Value } from "./ir.ts";
import type { DescriptorNode, DescriptorRecord, DescriptorType } from "./operations/descriptor.ts";

export type JavaScriptContext<T> = {
  readonly depth: number;
  readonly expr: (value: Value<T>, depth: number) => string;
  readonly block: (body: Body<T>, depth: number) => string;
  readonly name: (binding: Binding<T>) => string;
};

export type JavaScriptHandler<T> = {
  readonly operationId: symbol;
  readonly kind: string;
  readonly emit: (node: OperationNode, context: JavaScriptContext<T>) => string;
};

export type JavaScriptHandlers<D extends DescriptorRecord> = {
  readonly [Key in keyof D]: (node: DescriptorNode<D[Key]>, context: JavaScriptContext<DescriptorType<D>>) => string;
};
type OwnKeys<D, H> = Exclude<keyof D, keyof H> extends never ? unknown : never;

/** Pairs every descriptor with its emitter. Handlers must be own keys, so inherited `toString` cannot stand in. */
export const defineJavaScriptBackend = <
  const D extends DescriptorRecord,
  const H extends JavaScriptHandlers<NoInfer<D>>,
>(
  descriptors: D,
  handlers: H & OwnKeys<D, H>,
): readonly JavaScriptHandler<DescriptorType<D>>[] =>
  Object.entries(descriptors).map(([key, descriptor]) => ({
    operationId: descriptor.id,
    kind: descriptor.kind,
    emit: handlers[key] as JavaScriptHandler<DescriptorType<D>>["emit"],
  }));

/** Handlers match operations by descriptor identity, never by kind name. */
export const createJavaScriptEmitter = <T>(...sets: readonly (readonly JavaScriptHandler<T>[])[]) => {
  const handlers = new Map<symbol, JavaScriptHandler<T>>();
  for (const handler of sets.flat()) {
    if (handlers.has(handler.operationId)) throw new Error(`Duplicate JavaScript handler: ${handler.kind}`);
    handlers.set(handler.operationId, handler);
  }
  const emit = (program: Program<T>): string => {
    validate(program);
    const names = new Map<symbol, string>();
    const name = (binding: Binding<T>): string => {
      const known = names.get(binding.id);
      if (known) return known;
      const chosen = `_${binding.name.replace(/[^a-zA-Z0-9_]/g, "_")}_${names.size}`;
      names.set(binding.id, chosen);
      return chosen;
    };
    const block = (body: Body<T>, depth: number): string => {
      const indent = "  ".repeat(depth + 1);
      return [
        "{",
        ...body.declarations.map(({ binding, value }) =>
          `${indent}const ${name(binding)} = ${expr(value, depth + 1)};`
        ),
        `${indent}return ${expr(body.result, depth + 1)};`,
        `${"  ".repeat(depth)}}`,
      ].join("\n");
    };
    const expr = (value: Value<T>, depth: number): string => {
      const handler = handlers.get(value.operationId);
      if (!handler) throw new Error(`Missing JavaScript handler for operation: ${value.node.kind}`);
      return handler.emit(value.node, { expr, block, name, depth });
    };
    return `(() => ${block(program.body, 0)})()\n`;
  };
  return { emit };
};
