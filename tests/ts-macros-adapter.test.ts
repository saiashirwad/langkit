import assert from "node:assert/strict";
import test from "node:test";
import * as IR from "../src/ir.ts";
import { createTSMacrosAdapter } from "../src/adapters/ts-macros.ts";
import { records } from "../src/operations/records.ts";

type Env = Map<unknown, unknown>;
type E = { kind: string; id?: symbol; nameHint?: string; run: (env: Env) => unknown };
type S = { id: symbol; expr: E };
const expr = (run: E["run"]): E => ({ kind: "fixture", run });
const trace: unknown[] = [];
// This fixture tests our boundary and scheduling, not TS Macros compatibility.
const fixture = {
  number: (n: number) => expr(() => { trace.push(n); return n; }),
  string: (n: string) => expr(() => n), boolean: (n: boolean) => expr(() => n),
  ref: (id: symbol, nameHint: string) => ({ ...expr((env) => env.get(id)), id, nameHint }),
  param: (nameHint: string) => ({ ...expr(() => undefined), id: Symbol(), nameHint }),
  const: (nameHint: string, initial: E) => ({ *[Symbol.iterator]() {
    const id = Symbol(); yield { id, expr: initial };
    return fixture.ref(id, nameHint);
  } }),
  binary: (op: string, left: E, right: E) => expr((env) => {
    const a = left.run(env) as number, b = right.run(env) as number;
    return op === "+" ? a + b : op === "===" ? a === b : a / b;
  }),
  unary: (_op: string, operand: E) => expr((env) => !operand.run(env)),
  call: (fn: E, ...args: E[]) => expr((env) => (fn.run(env) as (...args: unknown[]) => unknown)(...args.map((arg) => arg.run(env)))),
  cond: (c: E, a: E, b: E) => expr((env) => (c.run(env) ? a : b).run(env)),
  arrow: (spec: { params: E[]; body: () => Generator<S, E> }) => {
    const iterator = spec.body(); const statements: S[] = []; let step = iterator.next();
    while (!step.done) { statements.push(step.value); step = iterator.next(); }
    const result = step.value;
    return expr((parent) => (...args: unknown[]) => {
      const env = new Map(parent); spec.params.forEach((param, i) => env.set(param.id, args[i]));
      for (const statement of statements) env.set(statement.id, statement.expr.run(env));
      return result.run(env);
    });
  },
  object: (fields: Record<string, E>) => expr((env) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.run(env)]))),
  prop: (object: E, name: string) => expr((env) => (object.run(env) as Record<string, unknown>)[name]),
  build: (body: () => Generator<S, E>) => {
    const iterator = body(); const statements: S[] = []; let step = iterator.next();
    while (!step.done) { statements.push(step.value); step = iterator.next(); }
    return { statements, result: step.value };
  },
};
const setup = () => {
  const feature = records<string>(); const ir = IR.create<string>().use(feature);
  const core = Object.fromEntries(ir.coreOperationTraversals().map((d) => [d.kind, d]));
  const recordDescriptors = Object.fromEntries(feature.operations.filter((d) => d.kind !== "merge").map((d) => [d.kind, d]));
  const adapter = createTSMacrosAdapter(fixture, { core, records: recordDescriptors }, (_guest: string) => undefined);
  const lower = (value: IR.Value<string>) => adapter.lower({ body: { declarations: [], result: value }, operations: ir.operationTraversals() });
  return { ir, adapter, lower };
};
const execute = (program: ReturnType<typeof fixture.build>) => {
  const env: Env = new Map();
  for (const statement of program.statements) env.set(statement.id, statement.expr.run(env));
  return program.result.run(env);
};
test("rejects same-kind foreign descriptors and missing registrations", () => {
  const { ir, lower, adapter } = setup();
  const foreign = IR.create<string>().literal("n", 1);
  assert.throws(() => lower(foreign), /Unsupported TS Macros descriptor: Symbol\(literal\)/);
  const own = ir.literal("n", 1);
  assert.throws(() => adapter.lower({ body: { declarations: [], result: own }, operations: [] }), /Unsupported TS Macros descriptor/);
  assert.equal(execute(adapter.lower({ body: { declarations: [], result: own }, operations: ir.operationTraversals().map((d) => ({ ...d })) }).program), 1);
});
test("rejects unsupported literal, operator, merge, record base and field names", () => {
  const { ir, lower } = setup(); const one = ir.literal("n", 1);
  for (const n of [NaN, Infinity]) assert.throws(() => lower(ir.literal("n", n)), /finite/);
  const nullNode = { kind: "literal", value: null };
  assert.throws(() => lower({ ...one, node: nullNode }), /Unsupported TS Macros literal/);
  assert.throws(() => lower(ir.merge("r", one, one)), /Unsupported TS Macros descriptor/);
  assert.throws(() => lower(ir.record("r", [], one)), /record bases/);
  assert.throws(() => lower(ir.record("r", [{ name: "a-b", value: one }])), /identifier field/);
  const unsupportedBinary = { kind: "binary", op: "%", left: one, right: one };
  assert.throws(() => lower({ ...one, node: unsupportedBinary, operationId: ir.coreOperationTraversals().find((d) => d.kind === "binary")!.id }), /Unsupported TS Macros binary/);
});
test("preserves ordering, lazy branches, blocks, capture and shadowing", () => {
  const { ir, adapter } = setup(); trace.length = 0;
  const param = ir.binding("x", "n");
  const body = ir.body(function* () {
    const captured = yield* ir.declare("x", ir.literal("n", 10));
    const fn = yield* ir.declare("f", ir.fn("f", param, { declarations: [], result: ir.binary("n", "+", captured, ir.ref(param)) }));
    return ir.conditional("n", ir.literal("b", true), { declarations: [], result: ir.block("n", { declarations: [], result: ir.call("n", fn, ir.literal("n", 2)) }) }, { declarations: [], result: ir.literal("n", 99) });
  });
  assert.equal(execute(adapter.lower(ir.program(body)).program), 12);
  assert.deepEqual(trace, [10, 2]);
});
test("retains declaration and polymorphic use types without inventing host generics", () => {
  const { ir, adapter } = setup();
  const binding = ir.binding("id", "scheme");
  const lowered = adapter.lower({ body: { declarations: [{ binding, value: ir.literal("scheme", 1) }], result: ir.ref(binding, "instantiated") }, operations: ir.operationTraversals() });
  assert.equal(lowered.referenceUses[0]!.binding.type, "scheme");
  assert.equal(lowered.referenceUses[0]!.type, "instantiated");
});
test("validates scope, duplicate binding and recursion at its own boundary", () => {
  const { ir, lower, adapter } = setup(); const binding = ir.binding("x", "n"); const one = ir.literal("n", 1);
  assert.throws(() => lower(ir.ref(binding)), /Out-of-scope/);
  const declaration = { binding, value: one };
  assert.throws(() => adapter.lower({ body: { declarations: [declaration, declaration], result: one }, operations: ir.operationTraversals() }), /declared twice/);
  assert.throws(() => adapter.lower({ body: { declarations: [{ ...declaration, recursive: true }], result: one }, operations: ir.operationTraversals() }), /recursive declarations/);
});
test("lowers deep expression trees with an explicit work stack", () => {
  const { ir, lower } = setup(); let value: IR.Value<string> = ir.literal("n", 0);
  for (let i = 0; i < 20000; i++) value = ir.binary("n", "+", value, ir.literal("n", 1));
  const lowered = lower(value);
  assert.equal(lowered.program.statements.length, 40001);
  assert.equal(execute(lowered.program), 20000);
});
