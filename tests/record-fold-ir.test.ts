import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { create, type Value } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { foldersJavaScript } from "langkit/javascript/folders";
import { printingJavaScript } from "langkit/javascript/printing";
import { recordsJavaScript } from "langkit/javascript/records";
import { folders } from "langkit/operations/folders";
import { printing } from "langkit/operations/printing";
import { records } from "langkit/operations/records";

const recordSet = records<string>();
const printSet = printing<string>();
const folderSet = folders<string>();
const code = create<string>().use(recordSet).use(printSet).use(folderSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreOperationTraversals()),
  recordsJavaScript(recordSet.operations),
  printingJavaScript(printSet.operations),
  foldersJavaScript(folderSet.operations),
);
const body = (result: Value<string>) => ({ declarations: [], result });
const effect = (label: string, result: Value<string>): Value<string> => code.block(result.type, {
  declarations: [{ binding: code.binding(label, "unit"), value: code.print("unit", code.literal("string", label)) }],
  result,
});
const makeStep = (): Value<string> => {
  const acc = code.binding("$acc", "number");
  const meta = code.binding("$key", "string");
  const value = code.binding("$record", "number");
  return code.fn("function", acc, body(code.fn("function", meta, body(code.fn("function", value, {
    declarations: [{ binding: code.binding("printed", "unit"), value: code.print("unit", code.ref(meta)) }],
    result: code.binary("number", "+", code.ref(acc), code.ref(value)),
  })))));
};
const evaluate = (result: Value<string>, output: unknown[]) => runInNewContext(
  javascript.emit(body(result), { operations: code.operationTraversals(), coreFunctionId: code.coreFunctionId() }),
  { console: { log: (value: unknown) => output.push(value) } },
);

test("record-fold IR evaluates arguments once, uses explicit order, and avoids temporary capture", () => {
  const result = code.recordFold("number",
    effect("order", code.fieldOrder("folder", ["y", "x"])),
    effect("metadata", code.record("record", [
      { name: "x", value: code.literal("string", "X") }, { name: "y", value: code.literal("string", "Y") },
    ])),
    effect("record", code.record("record", [
      { name: "x", value: code.literal("number", 20) }, { name: "y", value: code.literal("number", 22) },
    ])),
    effect("initial", code.literal("number", 0)), effect("step", makeStep()));
  const output: unknown[] = [];
  assert.equal(evaluate(result, output), 42);
  assert.deepEqual(output, ["order", "metadata", "record", "initial", "step", "Y", "X"]);
});

test("empty record-fold evaluates arguments but never calls its step", () => {
  const result = code.recordFold("number", code.fieldOrder("folder", []),
    effect("metadata", code.record("record", [])), effect("record", code.record("record", [])),
    effect("initial", code.literal("number", 42)), effect("step", makeStep()));
  const output: unknown[] = [];
  assert.equal(evaluate(result, output), 42);
  assert.deepEqual(output, ["metadata", "record", "initial", "step"]);
});

test("record-fold validates scope in every operand", () => {
  for (let index = 0; index < 5; index++) {
    const operands: Value<string>[] = [code.fieldOrder("folder", []), code.record("record", []), code.record("record", []), code.literal("number", 0), makeStep()];
    operands[index] = code.ref(code.binding("missing", "unknown"));
    const result = code.recordFold("number", operands[0]!, operands[1]!, operands[2]!, operands[3]!, operands[4]!);
    assert.throws(() => code.validate(body(result)), /Out-of-scope binding: missing/);
    assert.throws(() => javascript.emit(body(result), { operations: code.operationTraversals() }), /Out-of-scope binding: missing/);
  }
});
