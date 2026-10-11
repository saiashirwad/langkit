import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createStagingAdapter } from "../src/adapters/staging.ts";
import * as IR from "../src/ir.ts";
import { records } from "../src/operations/records.ts";
import type { Program } from "../src/staging.ts";
import { Number as Numeric, Unknown } from "../src/staging.ts";
import { emitProgram } from "../src/staging/javascript.ts";

const setup = () => {
  const feature = records<string>();
  const ir = IR.create<string>().use(feature);
  const { conditional, ...coreDescriptors } = ir.coreDescriptors;
  const core = { ...coreDescriptors, if: conditional };
  const { record, field } = feature.descriptors;
  const recordDescriptors = { record, field };
  const adapter = createStagingAdapter<string>({ core, records: recordDescriptors });
  const lower = (value: IR.Value<string>) =>
    adapter.lower({ body: { declarations: [], result: value }, operations: ir.operationTraversals() });
  return { ir, adapter, lower };
};
const execute = (program: Program<unknown>) => runInNewContext(emitProgram(program));
test("rejects same-kind foreign descriptors and missing registrations", () => {
  const { ir, lower, adapter } = setup();
  const foreign = IR.create<string>().literal("n", 1);
  assert.throws(() => lower(foreign), /Unsupported staging descriptor: Symbol\(literal\)/);
  const own = ir.literal("n", 1);
  assert.throws(
    () => adapter.lower({ body: { declarations: [], result: own }, operations: [] }),
    /Unsupported staging descriptor/,
  );
  assert.equal(
    execute(
      adapter.lower({
        body: { declarations: [], result: own },
        operations: ir.operationTraversals().map((d) => ({ ...d })),
      }).program,
    ),
    1,
  );
});
test("rejects unsupported literal, operator, merge and record base", () => {
  const { ir, lower } = setup();
  const one = ir.literal("n", 1);
  for (const n of [NaN, Infinity]) assert.throws(() => lower(ir.literal("n", n)), /finite/);
  const nullNode = { kind: "literal", value: null };
  assert.throws(() => lower({ ...one, node: nullNode }), /Unsupported staging literal/);
  assert.throws(() => lower(ir.merge("r", one, one)), /Unsupported staging descriptor/);
  assert.throws(() => lower(ir.record("r", [], one)), /record bases/);
  const unsupportedBinary = { kind: "binary", op: "%", left: one, right: one };
  assert.throws(
    () => lower({ ...one, node: unsupportedBinary, operationId: ir.coreDescriptors.binary.id }),
    /Unsupported staging binary/,
  );
});
test("local staging lowers arbitrary string field names as own properties", () => {
  const { ir, lower } = setup();
  for (const name of ["a-b", "__proto__", "", "quote\"", "if", "λ"]) {
    const record = ir.record("r", [{ name, value: ir.literal("n", 42) }]);
    assert.equal(execute(lower(ir.field("n", record, name)).program), 42);
  }
});

test("host witness policies accept numeric witnesses without promising a host output type", () => {
  const { ir } = setup();
  const { conditional, ...descriptors } = ir.coreDescriptors;
  const adapter = createStagingAdapter<string>(
    { core: { ...descriptors, if: conditional } },
    guest => guest === "n" ? Numeric : Unknown,
  );
  const parameter = ir.binding("x", "n");
  const fn = ir.fn("f", parameter, { declarations: [], result: ir.ref(parameter) });
  assert.equal(
    execute(adapter.lower(ir.program({ declarations: [], result: ir.call("n", fn, ir.literal("n", 42)) })).program),
    42,
  );
});
test("preserves ordering, lazy branches, blocks, capture and shadowing", () => {
  const { ir, adapter } = setup();
  const tick = ir.binding("tick", "host-callback");
  const trace: number[] = [];
  const observed = (n: number) => ir.call("n", ir.ref(tick), ir.literal("n", n));
  const param = ir.binding("x", "n");
  const body = ir.body(function*() {
    const captured = yield* ir.declare("x", observed(10));
    const fn = yield* ir.declare(
      "f",
      ir.fn("f", param, { declarations: [], result: ir.binary("n", "+", captured, ir.ref(param)) }),
    );
    return ir.conditional("n", ir.literal("b", true), {
      declarations: [],
      result: ir.block("n", { declarations: [], result: ir.call("n", fn, observed(2)) }),
    }, { declarations: [], result: observed(99) });
  });
  const entry = execute(
    adapter.lower(ir.program({ declarations: [], result: ir.fn("entry", tick, body) })).program,
  ) as (tick: (n: number) => number) => number;
  assert.equal(
    entry((n) => {
      trace.push(n);
      return n;
    }),
    12,
  );
  assert.deepEqual(trace, [10, 2]);
});
test("retains declaration and polymorphic use types without inventing host generics", () => {
  const { ir, adapter } = setup();
  const binding = ir.binding("id", "scheme");
  const lowered = adapter.lower({
    body: { declarations: [{ binding, value: ir.literal("scheme", 1) }], result: ir.ref(binding, "instantiated") },
    operations: ir.operationTraversals(),
  });
  assert.equal(lowered.referenceUses[0]!.binding.type, "scheme");
  assert.equal(lowered.referenceUses[0]!.type, "instantiated");
  assert.equal(lowered.program.result.shape.kind, "unknown");
  assert.equal(lowered.referenceUses[0]!.reference.data.id, lowered.program.statements[1]!.id);
});
test("validates scope, duplicate binding and recursion at its own boundary", () => {
  const { ir, lower, adapter } = setup();
  const binding = ir.binding("x", "n");
  const one = ir.literal("n", 1);
  assert.throws(() => lower(ir.ref(binding)), /Out-of-scope/);
  const declaration = { binding, value: one };
  assert.throws(
    () =>
      adapter.lower({
        body: { declarations: [declaration, declaration], result: one },
        operations: ir.operationTraversals(),
      }),
    /declared twice/,
  );
  assert.throws(
    () =>
      adapter.lower({
        body: { declarations: [{ ...declaration, recursive: true }], result: one },
        operations: ir.operationTraversals(),
      }),
    /recursive declarations/,
  );
});
test("lowers deep expression trees with an explicit work stack", () => {
  const { ir, lower } = setup();
  let value: IR.Value<string> = ir.literal("n", 0);
  for (let i = 0; i < 20000; i++) value = ir.binary("n", "+", value, ir.literal("n", 1));
  const lowered = lower(value);
  assert.equal(lowered.program.statements.length, 40001);
  assert.equal(execute(lowered.program), 20000);
});
test("rejects cycles, duplicate registrations and malformed descriptor selections", () => {
  const { ir, adapter, lower } = setup();
  const one = ir.literal("n", 1);
  const node: { kind: string; op: string; left: IR.Value<string>; right: IR.Value<string>; } = {
    kind: "binary",
    op: "+",
    left: one,
    right: one,
  };
  const cyclic = { ...one, node, operationId: ir.coreDescriptors.binary.id };
  node.left = cyclic;
  assert.throws(() => lower(cyclic), /Cyclic IR value/);
  assert.throws(
    () =>
      adapter.lower({
        body: { declarations: [], result: one },
        operations: [...ir.operationTraversals(), ...ir.operationTraversals()],
      }),
    /Duplicate program operation/,
  );
  assert.throws(() => createStagingAdapter({ core: { literal: ir.coreDescriptors.binary } }), /role mismatch/);
  assert.throws(
    () =>
      createStagingAdapter({
        core: {
          literal: ir.coreDescriptors.literal,
          binary: { ...ir.coreDescriptors.binary, id: ir.coreDescriptors.literal.id },
        },
      }),
    /Duplicate staging descriptor/,
  );
  const wrongNode = { kind: "ref", binding: ir.binding("x", "n") };
  assert.throws(() => lower({ ...one, node: wrongNode }), /descriptor node mismatch/);
});
test("host witness policies are checked by local constructors rather than trusted as type proofs", () => {
  const { ir } = setup();
  const { conditional, ...descriptors } = ir.coreDescriptors;
  const adapter = createStagingAdapter<string>(
    { core: { ...descriptors, if: conditional } },
    () => 1 as unknown as typeof Unknown,
  );
  const parameter = ir.binding("x", "n");
  assert.throws(
    () =>
      adapter.lower(
        ir.program({
          declarations: [],
          result: ir.fn("f", parameter, { declarations: [], result: ir.ref(parameter) }),
        }),
      ),
    /Type witness/,
  );
});
