import { create, type Value } from "../src/ir.ts";
import { defineOperation } from "../src/operations/descriptor.ts";
import { defineBackend, defineDialect } from "../src/operations/dialect.ts";
import { records } from "../src/operations/records.ts";
import { variants } from "../src/operations/variants.ts";
import { folders } from "../src/operations/folders.ts";
import { defineJavaScriptBackend } from "../src/javascript/operations.ts";
import { definePythonBackend } from "../src/python/operations.ts";
import type { JavaScriptContext } from "../src/javascript.ts";
import type { PythonContext } from "../src/python.ts";
import { elaboration } from "../src/ir/check.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
const expect = <T extends true>(_proof: T): void => {};
const operation = defineOperation<"number", { readonly kind: "same-kind"; readonly count: number }>("same-kind", {
  children: () => [], scopedBodies: () => [], references: () => [], map: (node) => node,
});
const dialect = defineDialect({ authorKey: operation });
expect<Equal<keyof typeof dialect.descriptors, "authorKey">>(true);

defineJavaScriptBackend(dialect, {
  authorKey: (node, context) => {
    expect<Equal<typeof node, { readonly kind: "same-kind"; readonly count: number }>>(true);
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
definePythonBackend(dialect, {
  authorKey: (node, context) => {
    expect<Equal<typeof context, PythonContext<"number">>>(true);
    expect<Equal<IsAny<typeof node>, false>>(true);
    return String(node.count + context.depth);
  },
});
defineBackend<{ readonly prefix: string }>()(dialect, {
  authorKey: (node, context) => context.prefix + node.count,
});
// @ts-expect-error Exact dialect keys cannot widen to an empty record.
defineJavaScriptBackend(dialect, {});
// @ts-expect-error Python also requires the exact selected key.
definePythonBackend(dialect, {});
// @ts-expect-error The generic factory also prevents missing-handler inference.
defineBackend<{ readonly prefix: string }>()(dialect, {});
defineJavaScriptBackend(dialect, {
  // @ts-expect-error Incorrect callback nodes are rejected.
  authorKey: (node: { kind: "same-kind"; missing: string }) => node.missing,
});
definePythonBackend(dialect, {
  // @ts-expect-error Incorrect callback context is rejected.
  authorKey: (_node, context: { incorrect: true }) => String(context.incorrect),
});
const recordFeature = records<"number">();
const builder = create<"number">().use(recordFeature);
expect<Equal<keyof typeof builder.descriptors, "literal" | "ref" | "binary" | "call" | "fn" | "conditional" | "block" | "record" | "merge" | "field">>(true);
const checked = elaboration(builder);
expect<Equal<keyof typeof checked.descriptors, keyof typeof builder.descriptors>>(true);
expect<Equal<keyof ReturnType<typeof checked.dialect>["descriptors"], keyof typeof builder.descriptors>>(true);
// @ts-expect-error Checked builders retain exact selected handler coverage.
defineJavaScriptBackend(checked.dialect(), {});
// @ts-expect-error Checked builder dialects cannot narrow to the supplied partial table.
definePythonBackend(checked.dialect(), { literal: node => String(node.value) });
defineJavaScriptBackend(defineDialect({ projection: checked.descriptors.field }), {
  projection: (node, context) => {
    expect<Equal<typeof node.record, Value<"number">>>(true);
    expect<Equal<IsAny<typeof node>, false>>(true);
    expect<Equal<typeof context, JavaScriptContext<"number">>>(true);
    return context.expr(node.record, context.depth) + node.name;
  },
});
defineJavaScriptBackend(defineDialect({ chosenField: builder.descriptors.field }), {
  chosenField: (node, context) => {
    expect<Equal<typeof node.record, Value<"number">>>(true);
    return context.expr(node.record, context.depth) + node.name;
  },
});
defineJavaScriptBackend(defineDialect({ literal: builder.coreDescriptors.literal, conditional: builder.coreDescriptors.conditional }), {
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
});
const variantFeature = variants<"number">();
definePythonBackend(defineDialect({ injection: variantFeature.descriptors.variant }), {
  injection: (node) => {
    expect<Equal<typeof node.fields, readonly Value<"number">[]>>(true);
    expect<Equal<IsAny<typeof node.tag>, false>>(true);
    return node.tag;
  },
});
const folderFeature = folders<"number">();
defineJavaScriptBackend(defineDialect({ order: folderFeature.descriptors.fieldOrder }), {
  order: (node) => {
    expect<Equal<typeof node.names, readonly string[]>>(true);
    expect<Equal<IsAny<typeof node.names>, false>>(true);
    return node.names.join(",");
  },
});
// @ts-expect-error Both selected operation keys are required, not just those in the table.
defineJavaScriptBackend(defineDialect({ one: operation, two: builder.coreDescriptors.literal }), { one: (node) => String(node.count) });
// @ts-expect-error Registry entries must be operation descriptors, not merely IDs.
defineDialect({ invalid: { id: Symbol(), kind: "invalid" } });
