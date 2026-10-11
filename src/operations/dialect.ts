import type { OperationNode, OperationTraversal } from "../ir.ts";
import { traversalOf, type OperationDescriptor } from "./descriptor.ts";

export type DescriptorRecord = Readonly<Record<string, {
  readonly id: symbol;
  readonly kind: string;
  readonly children: (...args: never[]) => unknown;
  readonly scopedBodies: (...args: never[]) => unknown;
  readonly references: (...args: never[]) => unknown;
  readonly map: (...args: never[]) => unknown;
  readonly make: (...args: never[]) => unknown;
  readonly is: (...args: never[]) => unknown;
}>>;
export type DescriptorNode<D> = D extends OperationDescriptor<infer _T, infer Node> ? Node : never;
export type DescriptorType<D> = D extends OperationDescriptor<infer T, infer _Node> ? T : never;
export type DialectType<D extends DescriptorRecord> = DescriptorType<D[keyof D]>;
export type Dialect<D extends DescriptorRecord, T = DialectType<D>> = {
  readonly descriptors: D;
  readonly operations: readonly OperationTraversal<T>[];
};
export type BackendHandlers<D extends DescriptorRecord, Context, Output> = {
  readonly [Key in keyof D]: (node: DescriptorNode<D[Key]>, context: Context) => Output;
};
export type CompleteBackendHandlers<D extends DescriptorRecord, H> = Exclude<keyof D, keyof H> extends never ? H : never;
export type BackendHandler<Context, Output> = {
  readonly operationId: symbol;
  readonly kind: string;
  readonly emit: (node: OperationNode, context: Context) => Output;
};

export const defineDialect = <const D extends DescriptorRecord>(descriptors: D): Dialect<D> => {
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(descriptors, key)) {
      throw new Error("Dialect descriptor keys must be enumerable string keys");
    }
  }
  const ids = new Set<symbol>();
  const operations = Object.values(descriptors).map((entry) => {
    const descriptor = Object.freeze(entry);
    if (ids.has(descriptor.id)) throw new Error(`Duplicate operation descriptor: ${descriptor.kind}`);
    ids.add(descriptor.id);
    return traversalOf(descriptor as unknown as OperationDescriptor<DialectType<D>, OperationNode>);
  });
  return Object.freeze({ descriptors: Object.freeze({ ...descriptors }), operations: Object.freeze(operations) });
};

export const composeDialects = <A extends DescriptorRecord, B extends DescriptorRecord>(left: Dialect<A>, right: Dialect<B>): Dialect<A & B> => {
  for (const key of Object.keys(right.descriptors)) {
    if (Object.hasOwn(left.descriptors, key)) throw new Error(`Duplicate dialect key: ${key}`);
  }
  return defineDialect({ ...left.descriptors, ...right.descriptors });
};

export const defineBackend = <Context, Output = string>() => <const D extends DescriptorRecord, const H extends BackendHandlers<NoInfer<D>, Context, Output>>(
  dialect: Dialect<D>,
  handlers: H & CompleteBackendHandlers<NoInfer<D>, H>,
): readonly BackendHandler<Context, Output>[] => Object.entries(dialect.descriptors).map(([key, descriptor]) => {
  if (!Object.hasOwn(handlers, key)) throw new Error(`Missing backend handler: ${key}`);
  const emit = handlers[key];
  if (typeof emit !== "function") throw new Error(`Missing backend handler: ${key}`);
  return {
    operationId: descriptor.id,
    kind: descriptor.kind,
    emit: emit as unknown as (node: OperationNode, context: Context) => Output,
  };
});
