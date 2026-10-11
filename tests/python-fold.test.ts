import { type Body, create, type Declaration, type Reference, type Value } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { foldersJavaScript } from "langkit/javascript/folders";
import { printingJavaScript } from "langkit/javascript/printing";
import { recordsJavaScript } from "langkit/javascript/records";
import { folders } from "langkit/operations/folders";
import { printing } from "langkit/operations/printing";
import { records } from "langkit/operations/records";
import { createPythonEmitter } from "langkit/python";
import { corePython } from "langkit/python/core";
import { foldersPython, printingPython } from "langkit/python/features";
import { recordsPython } from "langkit/python/records";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const recordSet = records<string>();
const printingSet = printing<string>();
const folderSet = folders<string>();
const code = create<string>().use(recordSet).use(printingSet).use(folderSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreDescriptors),
  recordsJavaScript(recordSet.descriptors),
  printingJavaScript(printingSet.descriptors),
  foldersJavaScript(folderSet.descriptors),
);
const python = createPythonEmitter(
  corePython(code.coreDescriptors),
  recordsPython(recordSet.descriptors),
  printingPython(printingSet.descriptors),
  foldersPython(folderSet.descriptors),
);

const number = (value: number) => code.literal("number", value);
const string = (value: string) => code.literal("string", value);

function* declare(name: string, value: Value<string>): Generator<Declaration<string>, Reference<string>, unknown> {
  return yield* code.declare(name, value);
}

const pythonRun = (source: string): { result: unknown; prints: string[]; } => {
  const wrapper = [
    "import contextlib, io, json, sys",
    "out = io.StringIO(); ns = {}",
    "with contextlib.redirect_stdout(out): exec(compile(sys.stdin.read(), '<langkit-program>', 'exec'), ns)",
    "print(json.dumps({'result':ns['result'],'prints':out.getvalue().splitlines()}, ensure_ascii=True))",
  ].join("\n");
  const child = spawnSync("python3", ["-c", wrapper], { input: source, encoding: "utf8", timeout: 2000 });
  if (child.error && "code" in child.error && child.error.code === "ENOENT") {
    assert.fail("Python cross-target tests require Python 3 on PATH. Install python3 and rerun the suite.");
  }
  if (child.error) assert.fail("Python 3 execution failed: " + child.error.message);
  assert.equal(child.status, 0, "Python 3 program failed (status " + child.status + "):\n" + child.stderr);
  return JSON.parse(child.stdout) as { result: unknown; prints: string[]; };
};

const effect = (label: string, value: Value<string>): Value<string> =>
  code.block(value.type, function*() {
    yield* declare(`${label}_effect`, code.print("unit", string(label)));
    return value;
  });

const makeStep = (): Value<string> => {
  const acc = code.binding("acc", "number");
  return code.fn("function", acc, function*() {
    const meta = code.binding("meta", "number");
    return code.fn("function", meta, function*() {
      const value = code.binding("value", "number");
      return code.fn("function", value, function*() {
        const label = code.conditional("string", code.binary("boolean", "==", code.ref(value), number(1)), function*() {
          return string("b");
        }, function*() {
          return string("a");
        });
        yield* declare("step_label", code.print("unit", label));
        const scaled = code.binary("number", "*", code.ref(acc), number(10));
        const withMetadata = code.binary("number", "+", scaled, code.ref(meta));
        return code.binary("number", "+", withMetadata, code.ref(value));
      });
    });
  });
};

const buildFold = (empty: boolean): Body<string> => {
  const initial = empty ? 77 : 0;
  const orderedNames = empty ? [] : ["b", "a"];
  const metadataFields = empty
    ? []
    : [{ name: "a", value: number(10) }, { name: "b", value: number(32) }];
  const recordFields = empty
    ? []
    : [{ name: "a", value: number(100) }, { name: "b", value: number(1) }];
  return code.body(function*() {
    const step = yield* declare("step", makeStep());
    return code.recordFold(
      "number",
      effect("order", code.fieldOrder("folder", orderedNames)),
      effect("metadata", code.record("record", metadataFields)),
      effect("record", code.record("record", recordFields)),
      effect("initial", number(initial)),
      effect("step", step),
    );
  });
};

const compareTargets = (programBody: Body<string>, expectedResult: number, expectedPrints: string[]) => {
  const jsPrints: unknown[] = [];
  const jsResult = runInNewContext(javascript.emit(code.program(programBody)), {
    console: { log: (value: unknown) => jsPrints.push(value) },
  }, { timeout: 1000 });
  const py = pythonRun(python.emit(code.program(programBody)));
  assert.deepEqual({ result: py.result, prints: py.prints }, { result: jsResult, prints: jsPrints });
  assert.deepEqual({ result: jsResult, prints: jsPrints }, { result: expectedResult, prints: expectedPrints });
};

test("nonempty record fold follows explicit order and curries metadata before each field", () => {
  compareTargets(buildFold(false), 440, ["order", "metadata", "record", "initial", "step", "b", "a"]);
});

test("empty record fold evaluates operands but never invokes the step", () => {
  compareTargets(buildFold(true), 77, ["order", "metadata", "record", "initial", "step"]);
});
