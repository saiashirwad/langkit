import type { Binding, Body, OperationNode, Program, Value } from "./ir.ts";
import type { DescriptorNode, DescriptorRecord, DescriptorType } from "./operations/descriptor.ts";

export type JavaScriptContext<T> = {
  readonly expr: (value: Value<T>) => string;
  readonly block: (body: Body<T>, indent?: number) => string;
  /** A block wrapped as an immediately invoked arrow, so it reads as an expression. */
  readonly iife: (body: Body<T>, indent?: number) => string;
  readonly name: (binding: Binding<T>) => string;
  readonly fresh: (prefix: string) => string;
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
    const names = new Map<symbol, string>();
    const name = (binding: Binding<T>): string => {
      const known = names.get(binding.id);
      if (known) return known;
      const chosen = `_${binding.name.replace(/[^a-zA-Z0-9_]/g, "_")}_${names.size}`;
      names.set(binding.id, chosen);
      return chosen;
    };
    let temporaries = 0;
    const fresh = (prefix: string): string => `$${prefix}${temporaries++}`;
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
    const iife = (body: Body<T>, depth: number): string => `(() => ${block(body, depth)})()`;
    const expr = (value: Value<T>, depth: number): string => {
      const handler = handlers.get(value.operationId);
      if (!handler) throw new Error(`Missing JavaScript handler for operation: ${value.node.kind}`);
      return handler.emit(value.node, {
        expr: (child) => expr(child, depth),
        block: (body, indent = 0) => block(body, depth + indent),
        iife: (body, indent = 0) => iife(body, depth + indent),
        name,
        fresh,
      });
    };
    return `${iife(program.body, 0)}\n`;
  };
  return { emit };
};
