import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import * as IR from "../src/ir.ts";
import { records } from "../src/operations/records.ts";
import { createTSMacrosAdapter } from "../src/adapters/ts-macros.ts";

const [publicPath, jsPath] = process.argv.slice(2);
if (!publicPath || !jsPath) throw new Error("Usage: node tools/macros-integration.ts <ts-macros/src/index.ts> <ts-macros/targets/js.ts>");
const target = await import(pathToFileURL(publicPath).href);
const js = await import(pathToFileURL(jsPath).href);
const feature = records<string>();
const ir = IR.create<string>().use(feature);
const { conditional, ...coreDescriptors } = ir.coreDescriptors;
const core = { ...coreDescriptors, if: conditional };
const { record, field } = feature.descriptors;
const selectedRecords = { record, field };
const adapter = createTSMacrosAdapter(target, { core, records: selectedRecords }, (_guest: string) => target.Unknown);
let checks = 0;
const check = (body: IR.Body<string>, expected: unknown) => {
  const lowered = adapter.lower({ body, operations: ir.operationTraversals() });
  // build validates the adapter's output again, including the final observation.
  const observed = target.build(function* () {
    yield* lowered.program.statements;
    yield target.do(target.call(target.external("observe", undefined), lowered.program.result));
  });
  let actual: unknown;
  const code = js.emitProgram(observed);
  runInNewContext(code, { observe: (value: unknown) => { actual = value; } });
  assert.deepEqual(actual, expected);
  checks++;
};
const lit = (n: number) => ir.literal("number", n);
check(ir.body(function* () {
  const capture = yield* ir.declare("same", lit(40));
  const parameter = ir.binding("same", "number");
  const fn = yield* ir.declare("fn", ir.fn("function", parameter, ir.body(function* () {
    const local = yield* ir.declare("same", ir.binary("number", "+", ir.ref(parameter), capture));
    return local;
  })));
  return ir.call("number", fn, lit(2));
}), 42);
check(ir.body(function* () {
  const parameter = ir.binding("x", "number");
  return ir.call("number", ir.fn("function", parameter, { declarations: [], result: ir.ref(parameter) }), lit(7));
}), 7);
check({ declarations: [], result: ir.conditional("number", ir.literal("boolean", true),
  ir.body(function* () { const x = yield* ir.declare("x", lit(9)); return x; }),
  { declarations: [], result: ir.binary("number", "/", lit(1), lit(0)) }) }, 9);
check({ declarations: [], result: ir.block("number", ir.body(function* () {
  const x = yield* ir.declare("x", lit(5)); return ir.binary("number", "*", x, lit(3));
})) }, 15);
check({ declarations: [], result: ir.field("number", ir.record("record", [{ name: "__proto__", value: lit(11) }]), "__proto__") }, 11);
// Instrument host constructors to observe runtime (not construction) order.
const ordered = { ...target, number: (n: number) => target.call(target.external("tick", undefined), target.number(n)) };
const orderAdapter = createTSMacrosAdapter(ordered, { core, records: selectedRecords }, (_guest: string) => target.Unknown);
const orderBody = { declarations: [], result: ir.record("record", [{ name: "z", value: lit(1) }, { name: "a", value: lit(2) }]) };
const orderedProgram = orderAdapter.lower(ir.program(orderBody)).program;
const order: number[] = [];
runInNewContext(js.emitProgram(orderedProgram), { tick: (n: number) => { order.push(n); return n; } });
assert.deepEqual(order, [1, 2]); checks++;
const lazyProgram = orderAdapter.lower(ir.program({ declarations: [], result: ir.conditional("number", ir.literal("boolean", false),
  { declarations: [], result: lit(1) }, { declarations: [], result: lit(2) }) })).program;
order.length = 0;
runInNewContext(js.emitProgram(lazyProgram), { tick: (n: number) => { order.push(n); return n; } });
assert.deepEqual(order, [2]); checks++;
assert.throws(() => adapter.lower(ir.program({ declarations: [], result: ir.record("record", [{ name: "not-a-name", value: lit(1) }]) })), /identifier field/); checks++;
let deep: IR.Value<string> = lit(0);
for (let index = 0; index < 12000; index++) deep = ir.binary("number", "+", deep, lit(1));
check({ declarations: [], result: deep }, 12000);
console.log(`Real TS Macros integration: ${checks} checks passed`);
