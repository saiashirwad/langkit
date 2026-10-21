import { create, type Value } from "../src/ir.ts";
import { defineJavaScriptBackend, type JavaScriptContext } from "../src/javascript.ts";
import { defineOperation } from "../src/operations/descriptor.ts";
import { records } from "../src/operations/records.ts";
import { variants } from "../src/operations/variants.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
const expect = <T extends true>(_proof: T): void => {};
const operation = defineOperation<"number", { readonly kind: "same-kind"; readonly count: number; }>("same-kind");
const descriptors = { authorKey: operation };
const prototypeDescriptors = { toString: operation, constructor: operation, valueOf: operation };
// @ts-expect-error An intrinsic toString is not an explicitly supplied handler.
defineJavaScriptBackend({ toString: operation }, {});
// @ts-expect-error A normal handler cannot hide an absent toString key.
defineJavaScriptBackend({ toString: operation, own: operation }, { own: node => String(node.count) });
// @ts-expect-error An intrinsic constructor is not a handler.
defineJavaScriptBackend({ constructor: operation }, {});
// @ts-expect-error An intrinsic valueOf is not a handler.
defineJavaScriptBackend({ valueOf: operation }, {});
defineJavaScriptBackend(prototypeDescriptors, {
  toString: (node, context) => {
    expect<Equal<typeof node, { readonly kind: "same-kind"; readonly count: number; }>>(true);
    expect<Equal<typeof context, JavaScriptContext<"number">>>(true);
    return String(node.count);
  },
  constructor: node => String(node.count),
  valueOf: node => String(node.count),
});
// @ts-expect-error Prototype members do not supply table keys.
defineJavaScriptBackend(prototypeDescriptors, {});
// @ts-expect-error Partial prototype-name tables are incomplete.
defineJavaScriptBackend(prototypeDescriptors, { constructor: node => String(node.count) });
expect<Equal<keyof typeof descriptors, "authorKey">>(true);

defineJavaScriptBackend(descriptors, {
  authorKey: (node, context) => {
    expect<Equal<typeof node, { readonly kind: "same-kind"; readonly count: number; }>>(true);
    expect<Equal<IsAny<typeof node>, false>>(true);
    expect<Equal<typeof context, JavaScriptContext<"number">>>(true);
    expect<Equal<IsAny<typeof context>, false>>(true);
    // @ts-expect-error No restated or nonexistent node field.
    node.value;
    // @ts-expect-error Context preserves the selected type universe.
    context.expr({ type: "boolean", node, operationId: operation.id }, 0);
    return String(node.count);
  },
});
// @ts-expect-error Exact descriptor keys cannot widen to an empty record.
defineJavaScriptBackend(descriptors, {});
defineJavaScriptBackend(descriptors, {
  // @ts-expect-error Incorrect callback nodes are rejected.
  authorKey: (node: { kind: "same-kind"; missing: string; }) => node.missing,
});
const recordFeature = records<"number">();
const builder = create<"number">().use(recordFeature);
defineJavaScriptBackend({ projection: recordFeature.descriptors.field }, {
  projection: (node, context) => {
    expect<Equal<typeof node.record, Value<"number">>>(true);
    expect<Equal<IsAny<typeof node>, false>>(true);
    expect<Equal<typeof context, JavaScriptContext<"number">>>(true);
    return context.expr(node.record, context.depth) + node.name;
  },
});
defineJavaScriptBackend(
  { literal: builder.coreDescriptors.literal, conditional: builder.coreDescriptors.conditional },
  {
    literal: (node) => {
      expect<Equal<typeof node.value, number | boolean | string>>(true);
      expect<Equal<IsAny<typeof node.value>, false>>(true);
      return String(node.value);
    },
    conditional: (node, context) => {
      expect<Equal<typeof node.kind, "if">>(true);
      expect<Equal<typeof node.cond, Value<"number">>>(true);
      return context.block(node.then, context.depth);
    },
  },
);
const variantFeature = variants<"number">();
defineJavaScriptBackend({ injection: variantFeature.descriptors.variant }, {
  injection: (node) => {
    expect<Equal<typeof node.fields, readonly Value<"number">[]>>(true);
    expect<Equal<IsAny<typeof node.tag>, false>>(true);
    return node.tag;
  },
});
// @ts-expect-error Both selected operation keys are required, not just those in the table.
defineJavaScriptBackend({ one: operation, two: builder.coreDescriptors.literal }, {
  one: (node) => String(node.count),
});
