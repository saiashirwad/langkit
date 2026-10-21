import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { run } from "../src/check.ts";
import { type Body, create, type Value } from "../src/ir.ts";
import { elaboration } from "../src/ir/check.ts";
import { emit } from "../src/javascript.ts";

test("operations evaluate left to right", () => {
  const language = create<string>();
  const num = (value: number) => language.literal("number", value);
  const effect = (label: string, result: Value<string>): Value<string> => {
    const parameter = language.binding("unused", "number");
    return language.call(
      "number",
      language.fn("function", parameter, {
        declarations: [{
          binding: language.binding(`printed-${label}`, "unit"),
          value: language.print("unit", language.literal("string", label)),
        }],
        result,
      }),
      num(0),
    );
  };
  const root: Body<string> = {
    declarations: [],
    result: language.binary("number", "+", effect("left", num(1)), effect("right", num(2))),
  };
  const log: string[] = [];
  assert.equal(runInNewContext(emit(root), { console: { log: (message: string) => log.push(message) } }), 3);
  assert.deepEqual(log, ["left", "right"]);
});

test("recursive declarations see their own binding", () => {
  const language = create<string>();
  const num = (value: number) => language.literal("number", value);
  const empty = (result: Value<string>): Body<string> => ({ declarations: [], result });
  const code = elaboration(language);
  const built = run(code.body(function*() {
    const factorial = language.binding("factorial", "number -> number");
    const n = language.binding("n", "number");
    const fn = language.fn(
      factorial.type,
      n,
      empty(language.conditional(
        "number",
        language.binary("boolean", "==", language.ref(n), num(0)),
        empty(num(1)),
        empty(language.binary(
          "number",
          "*",
          language.ref(n),
          language.call(
            "number",
            language.ref(factorial),
            language.binary("number", "-", language.ref(n), num(1)),
          ),
        )),
      )),
    );
    const reference = yield* code.declareRecursive(factorial, fn);
    return language.call("number", reference, num(5));
  }));
  assert.equal(built.success, true);
  if (!built.success) return;
  assert.equal(runInNewContext(emit(built.value)), 120);
});
