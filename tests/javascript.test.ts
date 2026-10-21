import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { run } from "../src/check.ts";
import * as ir from "../src/ir.ts";
import type { Body, Value } from "../src/ir.ts";
import { emit } from "../src/javascript.ts";

const num = (value: number) => ir.literal("number", value);
const empty = (result: Value<string>): Body<string> => ({ declarations: [], result });

test("operations evaluate left to right", () => {
  const effect = (label: string, result: Value<string>): Value<string> =>
    ir.call(
      "number",
      ir.fn("function", ir.binding("unused", "number"), {
        declarations: [{
          binding: ir.binding(`printed-${label}`, "unit"),
          value: ir.print("unit", ir.literal("string", label)),
        }],
        result,
      }),
      num(0),
    );
  const root = empty(ir.binary("number", "+", effect("left", num(1)), effect("right", num(2))));
  const log: string[] = [];
  assert.equal(runInNewContext(emit(root), { console: { log: (message: string) => log.push(message) } }), 3);
  assert.deepEqual(log, ["left", "right"]);
});

test("recursive declarations see their own binding", () => {
  const factorial = ir.binding("factorial", "number -> number");
  const n = ir.binding("n", "number");
  const fn = ir.fn(
    factorial.type,
    n,
    empty(ir.conditional(
      "number",
      ir.binary("boolean", "==", ir.ref(n), num(0)),
      empty(num(1)),
      empty(ir.binary(
        "number",
        "*",
        ir.ref(n),
        ir.call("number", ir.ref(factorial), ir.binary("number", "-", ir.ref(n), num(1))),
      )),
    )),
  );
  const built = run(
    ir.body(ir.declareRecursive(factorial, fn).map((reference) => ir.call("number", reference, num(5)))),
  );
  assert.equal(built.success, true);
  if (!built.success) return;
  assert.equal(runInNewContext(emit(built.value)), 120);
});
