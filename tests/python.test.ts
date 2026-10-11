import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { create, type Body, type Value, type Declaration } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { recordsJavaScript } from "langkit/javascript/records";
import { variantsJavaScript } from "langkit/javascript/variants";
import { printingJavaScript } from "langkit/javascript/printing";
import { createPythonEmitter } from "langkit/python";
import { corePython } from "langkit/python/core";
import { recordsPython } from "langkit/python/records";
import { variantsPython, printingPython } from "langkit/python/features";
import { variants } from "langkit/operations/variants";
import { printing } from "langkit/operations/printing";
import { records } from "langkit/operations/records";
import { defineOperation, traversalOf } from "langkit/operations/descriptor";
import { createPythonDispatcher, definePythonOperationHandler, operationIdFor } from "langkit/python/operations";
import type { PythonContext } from "langkit/python";
import type { OperationNode, OperationTraversal } from "langkit/ir";

const variantSet = variants<string>();
const printSet = printing<string>();
const recordSet = records<string>();
const code = create<string>().use(recordSet).use(variantSet).use(printSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreOperationTraversals()), recordsJavaScript(recordSet.operations),
  variantsJavaScript(variantSet.operations), printingJavaScript(printSet.operations),
);
const python = createPythonEmitter(
  corePython(code.coreOperationTraversals()), recordsPython(recordSet.operations),
  variantsPython(variantSet.operations), printingPython(printSet.operations),
);
const body = (result: Value<string>): Body<string> => ({ declarations: [], result });
const number = (n: number) => code.literal("number", n);
const bool = (b: boolean) => code.literal("boolean", b);
const str = (s: string) => code.literal("string", s);
function* declare(name: string, value: Value<string>): Generator<Declaration<string>, import("langkit/ir").Reference<string>, unknown> {
  return yield* code.declare(name, value);
}
const normalize = (v: unknown): unknown => {
  if (typeof v === "number") {
    if (Number.isNaN(v)) return { $number: "NaN" };
    if (v === Infinity) return { $number: "Infinity" };
    if (v === -Infinity) return { $number: "-Infinity" };
    if (Object.is(v, -0)) return { $number: "-0" };
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
};
const pythonRun = (source: string): { result: unknown; prints: string[] } => {
  const wrapper = [
    "import contextlib, io, json, math, sys",
    "out = io.StringIO(); ns = {}",
    "with contextlib.redirect_stdout(out): exec(compile(sys.stdin.read(), '<langkit-program>', 'exec'), ns)",
    "def norm(x):",
    "    if isinstance(x, float):",
    "        if math.isnan(x): return {'$number':'NaN'}",
    "        if math.isinf(x): return {'$number':'Infinity' if x > 0 else '-Infinity'}",
    "        if x == 0.0 and math.copysign(1.0, x) < 0: return {'$number':'-0'}",
    "    if isinstance(x, dict): return {k:norm(v) for k,v in x.items()}",
    "    if isinstance(x, (list,tuple)): return [norm(v) for v in x]",
    "    return x",
    "print(json.dumps({'result':norm(ns['result']),'prints':out.getvalue().splitlines()}, ensure_ascii=True, allow_nan=False))",
  ].join("\n");
  const child = spawnSync("python3", ["-c", wrapper], { input: source, encoding: "utf8", timeout: 2000 });
  if (child.error && "code" in child.error && child.error.code === "ENOENT") assert.fail("Python cross-target tests require Python 3 on PATH. Install python3 and rerun the suite.");
  if (child.error) assert.fail("Python 3 execution failed: " + child.error.message);
  assert.equal(child.status, 0, "Python 3 program failed (status " + child.status + "):\n" + child.stderr);
  return JSON.parse(child.stdout) as { result: unknown; prints: string[] };
};
const pythonError = (source: string): string => {
  const child = spawnSync("python3", ["-c", "import sys; exec(sys.stdin.read())"], { input: source, encoding: "utf8", timeout: 2000 });
  if (child.error && "code" in child.error && child.error.code === "ENOENT") assert.fail("Python cross-target tests require Python 3 on PATH. Install python3 and rerun the suite.");
  if (child.error) assert.fail("Python 3 execution failed: " + child.error.message);
  assert.notEqual(child.status, 0, "expected generated Python program to fail");
  return child.stderr;
};
const evaluate = (v: Value<string>, context: Record<string, unknown> = {}) => runInNewContext(
  javascript.emit(code.program(body(v))), context, { timeout: 1000 },
);
const bothBody = (programBody: Body<string>) => {
  const log: unknown[] = [];
  const js = runInNewContext(javascript.emit(code.program(programBody)), { console: { log: (x: unknown) => log.push(x) } }, { timeout: 1000 });
  const py = pythonRun(python.emit(code.program(programBody)));
  assert.deepEqual(py.result, normalize(js));
  return { js, log, pyLog: py.prints };
};
const both = (v: Value<string>) => bothBody(body(v));

test("generator declarations, yield-star helper, nested functions, branches and body callbacks execute on both targets", () => {
  function* helper(): Generator<Declaration<string>, Value<string>, unknown> {
    const a = yield* declare("left", number(19));
    const b = yield* declare("right", number(23));
    return code.binary("number", "+", a, b);
  }
  const param = code.binding("argument", "number");
  const fn = code.fn("function", param, function* () {
    const local = yield* declare("inner", code.binary("number", "+", code.ref(param), number(1)));
    return code.conditional("number", code.binary("number", ">", local, number(40)), function* () {
      return code.block("number", function* () { return code.binary("number", "+", local, number(1)); });
    }, function* () { return number(-1); });
  });
  const program = code.body(function* () {
    const sum = yield* helper();
    const nested = yield* declare("nested", fn);
    return code.call("number", nested, sum);
  });
  assert.equal(bothBody(program).js, 44);
});

test("lexical shadowing and closures retain invocation-local bindings across calls", () => {
  const outer = code.binding("x", "number");
  const inner = code.binding("x", "number");
  const makeClosure = code.fn("function", outer, function* () {
    const shadow = yield* declare("x", number(99));
    const closure = code.fn("function", inner, {
      declarations: [],
      result: code.binary("number", "+", code.binary("number", "+", code.ref(outer), shadow), code.ref(inner)),
    });
    return yield* declare("closure", closure);
  });
  const value = code.body(function* () {
    const maker = yield* declare("maker", makeClosure);
    const first = yield* declare("first", code.call("function", maker, number(1)));
    const second = yield* declare("second", code.call("function", maker, number(2)));
    return code.record("record", [
      { name: "first", value: code.call("number", first, number(10)) },
      { name: "second", value: code.call("number", second, number(10)) },
    ]);
  });
  assert.deepEqual(normalize(bothBody(value).js), { first: 110, second: 111 });
});

test("recursive declarations support factorial", () => {
  const factorial = code.binding("factorial", "function");
  const n = code.binding("n", "number");
  const fn = code.fn("function", n, function* () {
    return code.conditional("number", code.binary("number", ">", code.ref(n), number(1)), function* () {
      return code.binary("number", "*", code.ref(n), code.call("number", code.ref(factorial), code.binary("number", "-", code.ref(n), number(1))));
    }, function* () { return number(1); });
  });
  const program = code.body(function* () {
    const recursive = yield* code.declareRecursive(factorial, fn);
    return code.call("number", recursive, number(7));
  });
  assert.equal(bothBody(program).js, 5040);
});

test("lazy conditional and ordered binary effects do not evaluate rejected branch", () => {
  const failure = code.call("number", number(1), number(0));
  const result = code.binary("number", "+",
    code.conditional("number", bool(true), function* () {
      return code.block("number", function* () { yield* declare("chosenEffect", code.print("unit", str("chosen"))); return number(19); });
    }, function* () { return failure; }),
    code.block("number", function* () { yield* declare("rightEffect", code.print("unit", str("right"))); return number(23); }));
  const got = both(result);
  assert.equal(got.js, 42);
  assert.deepEqual(got.log, ["chosen", "right"]);
  assert.deepEqual(got.pyLog, ["chosen", "right"]);
});

test("record fields precede the base, and merge operands execute left to right", () => {
  const fields = code.record("record", [{ name: "field", value: code.block("number", function* () {
    yield* declare("fieldEffect", code.print("unit", str("field"))); return number(1);
  }) }], code.block("record", function* () {
    yield* declare("baseEffect", code.print("unit", str("base"))); return code.record("record", [{ name: "field", value: number(2) }, { name: "base", value: number(2) }]);
  }));
  const merged = code.merge("record",
    code.block("record", function* () { yield* declare("leftEffect", code.print("unit", str("left"))); return code.record("record", [{ name: "shared", value: number(1) }, { name: "left", value: number(1) }]); }),
    code.block("record", function* () { yield* declare("rightEffect", code.print("unit", str("right"))); return code.record("record", [{ name: "shared", value: number(2) }, { name: "right", value: number(2) }]); }),
  );
  const value = code.record("record", [{ name: "fields", value: fields }, { name: "merge", value: merged }]);
  const got = both(value);
  assert.deepEqual(got.log, ["field", "base", "left", "right"]);
  assert.deepEqual(got.pyLog, got.log);
  assert.deepEqual(normalize(got.js), { fields: { field: 1, base: 2 }, merge: { shared: 2, left: 1, right: 2 } });
});

test("variants select correct bindings, fallback bindings work, and missing alternatives fail", () => {
  const payload = code.binding("payload value", "number");
  const fallback = code.binding("unmatched", "variant");
  const selected = code.match("number", code.variant("variant", "chosen", [number(40), number(2)]), [
    { tag: "chosen", bindings: [payload], body: { declarations: [], result: code.binary("number", "+", code.ref(payload), number(2)) } },
  ], { binding: fallback, body: { declarations: [], result: number(-1) } });
  assert.equal(both(selected).js, 42);
  const unmatched = code.match("string", code.variant("variant", "other", []), [], {
    binding: fallback,
    body: { declarations: [], result: code.field("string", code.ref(fallback), "tag") },
  });
  assert.equal(both(unmatched).js, "other");
  const noMatch = code.match("number", code.variant("variant", "other", []), []);
  assert.throws(() => evaluate(noMatch), /non-exhaustive/i);
  assert.match(pythonError(python.emit(code.program(body(noMatch)))), /non-exhaustive/i);
});


test("numeric edge semantics and strict bool-number/object identity equality match", () => {
  const value = code.body(function* () {
    const shared = yield* declare("shared", code.record("record", [{ name: "v", value: number(1) }]));
    const a = yield* declare("a", code.record("record", [{ name: "v", value: number(1) }]));
    const b = yield* declare("b", code.record("record", [{ name: "v", value: number(1) }]));
    return code.record("record", [
      { name: "large", value: code.binary("number", "+", number(9007199254740992), number(1)) },
      { name: "posInf", value: code.binary("number", "/", number(1), number(0)) },
      { name: "negInf", value: code.binary("number", "/", number(1), number(-0)) },
      { name: "nan", value: code.binary("number", "/", number(0), number(0)) },
      { name: "negativeZero", value: number(-0) },
      { name: "boolNumber", value: code.binary("boolean", "==", bool(true), number(1)) },
      { name: "sameObject", value: code.binary("boolean", "==", shared, shared) },
      { name: "distinctObjects", value: code.binary("boolean", "==", a, b) },
    ]);
  });
  const got = bothBody(value).js as Record<string, number | boolean>;
  assert.equal(got.large, 9007199254740992);
  assert.equal(got.posInf, Infinity); assert.equal(got.negInf, -Infinity); assert.ok(Number.isNaN(got.nan));
  assert.ok(Object.is(got.negativeZero, -0)); assert.equal(got.boolNumber, false);
  assert.equal(got.sameObject, true); assert.equal(got.distinctObjects, false);
});

test("hostile escaped strings, record labels, and binding hints stay inert data", () => {
  const text = '"\\\n\r\t\u0000\u2028\u2029💩';
  const label = '"]; __import__("os").system("false") #\n';
  const program = code.body(function* () {
    const ref = yield* declare("x); throw 1; // 2invalid", str(text));
    return code.record("record", [{ name: label, value: ref }, { name: "__proto__", value: ref }, { name: "constructor", value: ref }]);
  });
  const js = runInNewContext(javascript.emit(code.program(program)), {}, { timeout: 1000 });
  const py = pythonRun(python.emit(code.program(program)));
  assert.deepEqual(py.result, normalize(js));
  assert.equal((js as Record<string, string>)[label], text);
});

test("custom typed Python operation handlers honor descriptor identity and reject unknown or duplicate ids", () => {
  type CustomNode = OperationNode & { readonly kind: "custom"; readonly value: number };
  const operation = defineOperation<string, CustomNode>("custom", {
    children: () => [], scopedBodies: () => [], references: () => [], map: (node) => node,
  });
  const traversal = traversalOf(operation) as OperationTraversal<string>;
  const feature = { operations: [traversal], methods: { custom: (n: number) => operation.make("number", { kind: "custom", value: n }) } };
  const customCode = create<string>().use(feature);
  const handler = definePythonOperationHandler<CustomNode, PythonContext<string>>(operation.id, "custom", (node) => String(node.value * 2));
  const emitter = createPythonEmitter(corePython(customCode.coreOperationTraversals()), [handler]);
  const program = customCode.program(customCode.body(function* () { return customCode.custom(21); }));
  assert.equal(pythonRun(emitter.emit(program)).result, 42);
  const wrongId = definePythonOperationHandler<CustomNode, PythonContext<string>>(Symbol("different"), "custom", () => "0");
  assert.throws(() => createPythonEmitter(corePython(customCode.coreOperationTraversals()), [wrongId]).emit(program), /Missing Python handler for operation: custom/);
  assert.throws(() => createPythonDispatcher(handler, handler), /Duplicate Python handler: custom/);
  assert.throws(() => createPythonEmitter(corePython(customCode.coreOperationTraversals()), [handler, handler]), /Duplicate Python handler: custom/);
  assert.equal(operationIdFor([traversal], "custom"), operation.id);
});
