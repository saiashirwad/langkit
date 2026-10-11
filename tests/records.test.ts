import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { create, type Value } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { printingJavaScript } from "langkit/javascript/printing";
import { recordsJavaScript } from "langkit/javascript/records";
import { printing } from "langkit/operations/printing";
import { records } from "langkit/operations/records";

const recordSet = records<string>();
const printSet = printing<string>();
const code = create<string>().use(recordSet).use(printSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreDescriptors),
  recordsJavaScript(recordSet.descriptors),
  printingJavaScript(printSet.descriptors),
);
const body = (result: Value<string>) => ({ declarations: [], result });
const emit = (result: Value<string>) => javascript.emit(code.program(body(result)));
const evaluate = (result: Value<string>, context = {}) => runInNewContext(emit(result), context);

test("record fields evaluate once in source order before the base, which merges first", () => {
  const seen: unknown[] = [];
  const effect = (label: string, value: Value<string>): Value<string> =>
    code.block(value.type, {
      declarations: [{ binding: code.binding(label, "unit"), value: code.print("unit", code.literal("string", label)) }],
      result: value,
    });
  const result = evaluate(
    code.record("record", [
      { name: "x", value: effect("first", code.literal("number", 1)) },
      { name: "y", value: effect("second", code.literal("number", 2)) },
    ], effect("base", code.record("record", [
      { name: "x", value: code.literal("number", 99) },
      { name: "z", value: code.literal("number", 3) },
    ]))),
    { console: { log: (value: unknown) => seen.push(value) } },
  );
  assert.deepEqual(seen, ["first", "second", "base"]);
  assert.deepEqual(Object.entries(result), [["x", 1], ["z", 3], ["y", 2]]);
  assert.equal(Object.getPrototypeOf(result), null);
});

test("record labels and string literals are escaped and have no inherited properties", () => {
  const labels = ["__proto__", "constructor", "toString", '"]; throw new Error("injected"); //', "line\n\u2028break"];
  const value = '"\\\n\r\t\u0000\u2028\u2029💩';
  for (const label of labels) {
    const record = code.record("record", [{ name: label, value: code.literal("string", value) }]);
    assert.equal(evaluate(code.field("string", record, label)), value);
    const runtime = evaluate(record);
    assert.equal(Object.getPrototypeOf(runtime), null);
    assert.deepEqual(Object.keys(runtime), [label]);
  }
  assert.equal(evaluate(code.field("unknown", code.record("record", []), "toString")), undefined);
});

test("print evaluates its operand once and returns an empty null-prototype record", () => {
  const seen: unknown[] = [];
  const result = evaluate(code.print("unit", code.print("unit", code.literal("string", "hello"))), {
    console: { log: (value: unknown) => seen.push(value) },
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0], "hello");
  assert.equal(Object.getPrototypeOf(seen[1]), null);
  assert.deepEqual(Object.keys(seen[1] as object), []);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(Object.keys(result), []);
  assert.notEqual(result, seen[1]);
});

test("scope validation traverses every record, field, and print child", () => {
  const escaped = code.ref(code.binding("escaped", "number"));
  for (const result of [
    code.record("record", [{ name: "x", value: escaped }]),
    code.record("record", [], escaped),
    code.field("number", escaped, "x"),
    code.merge("record", escaped, code.record("record", [])),
    code.merge("record", code.record("record", []), escaped),
    code.print("unit", escaped),
  ]) {
    assert.throws(() => code.validate(body(result)), /Out-of-scope binding: escaped/);
    assert.throws(() => emit(result), /Out-of-scope binding: escaped/);
  }
});

test("record merge evaluates each side once, left to right, without inherited properties", () => {
  const seen: unknown[] = [];
  const side = (label: string, key: string, value: number): Value<string> => code.block("record", {
    declarations: [{ binding: code.binding(label, "unit"), value: code.print("unit", code.literal("string", label)) }],
    result: code.record("record", [{ name: key, value: code.literal("number", value) }]),
  });
  const result = evaluate(code.merge("record", side("left", "__proto__", 20), side("right", "constructor", 22)), {
    console: { log: (value: unknown) => seen.push(value) },
  });
  assert.deepEqual(seen, ["left", "right"]);
  assert.deepEqual(Object.entries(result), [["__proto__", 20], ["constructor", 22]]);
  assert.equal(Object.getPrototypeOf(result), null);
});

test("record emission does not capture bindings named like its temporaries", () => {
  const binding = code.binding("field0", "number");
  const result = code.field("number", code.record("record", [{ name: "x", value: code.ref(binding) }]), "x");
  assert.equal(runInNewContext(javascript.emit(code.program({
    declarations: [{ binding, value: code.literal("number", 42) }], result,
  }))), 42);
});
