import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createStagingAdapter } from "../src/adapters/staging.ts";
import * as IR from "../src/ir.ts";
import { records } from "../src/operations/records.ts";
import * as target from "../src/staging.ts";
import * as js from "../src/staging/javascript.ts";

const feature = records<string>();
const ir = IR.create<string>().use(feature);
const { conditional, ...coreDescriptors } = ir.coreDescriptors;
const core = { ...coreDescriptors, if: conditional };
const { record, field } = feature.descriptors;
const selectedRecords = { record, field };
const adapter = createStagingAdapter<string>({ core, records: selectedRecords });
let checks = 0;
const check = (body: IR.Body<string>, expected: unknown) => {
  const lowered = adapter.lower({ body, operations: ir.operationTraversals() });
  const actual: unknown = runInNewContext(js.emitProgram(lowered.program));
  assert.deepEqual(actual, expected);
  checks++;
};
const lit = (n: number) => ir.literal("number", n);
check(
  ir.body(function*() {
    const capture = yield* ir.declare("same", lit(40));
    const parameter = ir.binding("same", "number");
    const fn = yield* ir.declare(
      "fn",
      ir.fn(
        "function",
        parameter,
        ir.body(function*() {
          const local = yield* ir.declare("same", ir.binary("number", "+", ir.ref(parameter), capture));
          return local;
        }),
      ),
    );
    return ir.call("number", fn, lit(2));
  }),
  42,
);
check(
  ir.body(function*() {
    const parameter = ir.binding("x", "number");
    return ir.call("number", ir.fn("function", parameter, { declarations: [], result: ir.ref(parameter) }), lit(7));
  }),
  7,
);
check({
  declarations: [],
  result: ir.conditional(
    "number",
    ir.literal("boolean", true),
    ir.body(function*() {
      const x = yield* ir.declare("x", lit(9));
      return x;
    }),
    { declarations: [], result: ir.binary("number", "/", lit(1), lit(0)) },
  ),
}, 9);
check({
  declarations: [],
  result: ir.block(
    "number",
    ir.body(function*() {
      const x = yield* ir.declare("x", lit(5));
      return ir.binary("number", "*", x, lit(3));
    }),
  ),
}, 15);
check({
  declarations: [],
  result: ir.field("number", ir.record("record", [{ name: "__proto__", value: lit(11) }]), "__proto__"),
}, 11);
const tick = ir.binding("tick", "host-callback");
const invokeTick = (n: number) => ir.call("number", ir.ref(tick), lit(n));
const callbackProgram = (result: IR.Value<string>) =>
  adapter.lower(ir.program({ declarations: [], result: ir.fn("entry", tick, { declarations: [], result }) })).program;
const orderedProgram = callbackProgram(
  ir.record("record", [{ name: "z", value: invokeTick(1) }, { name: "a", value: invokeTick(2) }]),
);
const order: number[] = [];
const runCallback = (program: target.Program<unknown>) => {
  const entry = runInNewContext(js.emitProgram(program)) as (tick: (n: number) => number) => unknown;
  return entry((n) => {
    order.push(n);
    return n;
  });
};
runCallback(orderedProgram);
assert.deepEqual(order, [1, 2]);
checks++;
const lazyProgram = callbackProgram(
  ir.conditional("number", ir.literal("boolean", false), { declarations: [], result: invokeTick(1) }, {
    declarations: [],
    result: invokeTick(2),
  }),
);
order.length = 0;
runCallback(lazyProgram);
assert.deepEqual(order, [2]);
checks++;
check({
  declarations: [],
  result: ir.field("number", ir.record("record", [{ name: "not-a-name", value: lit(1) }]), "not-a-name"),
}, 1);
let deep: IR.Value<string> = lit(0);
for (let index = 0; index < 12000; index++) deep = ir.binary("number", "+", deep, lit(1));
check({ declarations: [], result: deep }, 12000);
const host = target.build(function*() {
  const fn = yield* target.const(
    "add",
    target.arrow({
      params: [target.param("x", target.Number)],
      body: function*([x]) {
        return target.binary("+", x, target.number(1));
      },
    }),
  );
  return target.call(fn, target.number(41));
});
assert.equal(runInNewContext(js.emitProgram(host)), 42);
checks++;
console.log(`Local staging integration: ${checks} checks passed`);
