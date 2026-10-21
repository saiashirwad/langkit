import type { Binding, Body, OperationFeature, OperationNode, Value } from "../ir.ts";
import { defineOperation, type OperationDescriptor } from "./descriptor.ts";

export type MatchCase<T> = { readonly tag: string; readonly bindings: readonly Binding<T>[]; readonly body: Body<T>; };
export type MatchFallback<T> = { readonly binding?: Binding<T>; readonly body: Body<T>; };

type VariantNode<T> = OperationNode & {
  readonly kind: "variant";
  readonly tag: string;
  readonly fields: readonly Value<T>[];
};
type MatchNode<T> = OperationNode & {
  readonly kind: "match";
  readonly value: Value<T>;
  readonly cases: readonly MatchCase<T>[];
  readonly fallback?: MatchFallback<T>;
};
export type VariantMethods<T> = {
  variant(type: T, tag: string, fields: readonly Value<T>[]): Value<T>;
  match(type: T, matched: Value<T>, cases: readonly MatchCase<T>[], fallback?: MatchFallback<T>): Value<T>;
};

export type VariantDescriptors<T> = {
  readonly variant: OperationDescriptor<T, VariantNode<T>>;
  readonly match: OperationDescriptor<T, MatchNode<T>>;
};

export const variants = <T>(): OperationFeature<T, VariantMethods<T>, VariantDescriptors<T>> => {
  const variant = defineOperation<T, VariantNode<T>>("variant", {
    children: (node) => node.fields,
  });
  const match = defineOperation<T, MatchNode<T>>("match", {
    children: (node) => [node.value],
    scopedBodies: (node) => [
      ...node.cases.map((branch) => ({ body: branch.body, bindings: branch.bindings })),
      ...(node.fallback
        ? [{ body: node.fallback.body, bindings: node.fallback.binding ? [node.fallback.binding] : [] }]
        : []),
    ],
    validate: (node) => {
      const tags = new Set<string>();
      for (const branch of node.cases) {
        if (tags.has(branch.tag)) throw new Error(`Duplicate match case tag: ${branch.tag}`);
        tags.add(branch.tag);
      }
    },
  });
  return {
    descriptors: { variant, match },
    methods: {
      variant: (type, tag, fields) => variant.make(type, { kind: "variant", tag, fields }),
      match: (type, matched, cases, fallback) =>
        match.make(
          type,
          fallback ? { kind: "match", value: matched, cases, fallback } : { kind: "match", value: matched, cases },
        ),
    },
  };
};
