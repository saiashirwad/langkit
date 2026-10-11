import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { check, run } from "langkit";
import { create, isReference, type Body, type Value } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { printingJavaScript } from "langkit/javascript/printing";
import { variantsJavaScript } from "langkit/javascript/variants";
import { printing } from "langkit/operations/printing";
import { variants } from "langkit/operations/variants";

const variantSet = variants<string>();
const printSet = printing<string>();
const code = create<string>().use(variantSet).use(printSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreOperationTraversals()),
  variantsJavaScript(variantSet.operations),
  printingJavaScript(printSet.operations),
);

const body = (result: Value<string>): Body<string> => ({ declarations: [], result });

const num = (n: number) => code.literal("number", n);

const evaluate = (root: Body<string>, context = {}) =>
  runInNewContext(javascript.emit(root, { operations: code.operationTraversals(), coreFunctionId: code.coreFunctionId() }), context, { timeout: 1000 });

test("recursive declarations preserve identity and execute factorial", () => {
  const computation = code.body(
    check(function* () {
      const factorial = code.binding("factorial", "number -> number");
      const n = code.binding("n", "number");
      const recursiveCall = code.call(
        "number",
        code.ref(factorial),
        code.binary("number", "-", code.ref(n), num(1)),
      );
      const value = code.fn(
        factorial.type,
        n,
        body(
          code.conditional(
            "number",
            code.binary("boolean", "==", code.ref(n), num(0)),
            body(num(1)),
            body(code.binary("number", "*", code.ref(n), recursiveCall)),
          ),
        ),
      );
      const reference = yield* code.declareRecursive(factorial, value);
      assert.ok(isReference(reference, code.coreReferenceId()));
      assert.equal(reference.node.binding, factorial);
      return code.call("number", reference, num(5));
    }),
  );
  for (let i = 0; i < 2; i++) {
    const result = run(computation);
    assert.ok(result.success);
    code.validate(result.value);
    assert.equal(result.value.declarations[0]!.recursive, true);
    assert.equal(evaluate(result.value), 120);
  }
});

test("recursive declarations reject non-functions at construction and validation", () => {
  const target = code.binding("bad", "number");
  assert.throws(
    () => run(code.body(code.declareRecursive(target, num(1)))),
    /function initializer/,
  );
  assert.throws(
    () =>
      code.validate({
        declarations: [{ binding: target, value: num(1), recursive: true }],
        result: code.ref(target),
      }),
    /function initializer/,
  );
  const parameter = code.binding("x", "number");
  assert.throws(
    () => run(code.declareRecursive(target, code.fn("function", parameter, body(num(1))))),
    /enclosing body/,
  );
});

test("normal declarations still reject self-reference and forward reference", () => {
  const f = code.binding("f", "function");
  const x = code.binding("x", "number");
  assert.throws(
    () =>
      code.validate({
        declarations: [{ binding: f, value: code.fn("function", x, body(code.ref(f))) }],
        result: code.ref(f),
      }),
    /Out-of-scope binding: f/,
  );
  const a = code.binding("a", "number");
  const b = code.binding("b", "number");
  assert.throws(
    () =>
      code.validate({
        declarations: [
          { binding: a, value: code.ref(b) },
          { binding: b, value: num(1) },
        ],
        result: code.ref(a),
      }),
    /Out-of-scope binding: b/,
  );
});

const effect = (label: string, value: Value<string>): Value<string> => code.block(value.type, {
  declarations: [{ binding: code.binding("effect", "unit"), value: code.print("unit", code.literal("string", label)) }],
  result: value,
});

test("variants and match evaluate fields and scrutinee once, run only selected branch", () => {
  const output: unknown[] = [];
  const first = code.binding("first", "number");
  const second = code.binding("second", "number");
  const matched = effect(
    "scrutinee",
    code.variant("Pair", "Pair", [effect("first", num(4)), effect("second", num(2))]),
  );
  const result = code.match(
    "number",
    matched,
    [
      { tag: "Other", bindings: [], body: body(effect("wrong", num(0))) },
      {
        tag: "Pair",
        bindings: [first, second],
        body: body(
          effect(
            "selected",
            code.binary(
              "number",
              "+",
              code.binary("number", "*", code.ref(first), num(10)),
              code.ref(second),
            ),
          ),
        ),
      },
    ],
    { body: body(effect("fallback", num(-1))) },
  );
  assert.equal(evaluate(body(result), { console: { log: (x: unknown) => output.push(x) } }), 42);
  assert.deepEqual(output, ["scrutinee", "first", "second", "selected"]);
});

test("match fallback binds whole scrutinee; missing branches throw", () => {
  const matched = code.variant("Option", "Some", [num(42)]);
  const whole = code.binding("whole", "Option");
  const result = evaluate(
    body(code.match("Option", matched, [], { binding: whole, body: body(code.ref(whole)) })),
  );
  assert.equal(result.tag, "Some");
  assert.deepEqual([...result.fields], [42]);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(evaluate(body(code.match("number", matched, [], { body: body(num(7)) }))), 7);
  assert.throws(
    () => evaluate(body(code.match("number", matched, []))),
    /Internal non-exhaustive match/,
  );
});

test("variant tags are escaped and match temporaries do not capture user bindings", () => {
  for (const tag of [
    "__proto__",
    "constructor",
    '\"); throw new Error("injected"); //',
    "line\n\u2028break",
  ]) {
    const value = code.binding("$match0", "number");
    const parameter = code.binding("match0", "number");
    const inner = code.match("number", code.variant("T", tag, [code.ref(parameter)]), [
      { tag, bindings: [code.binding("unused", "number")], body: body(code.ref(value)) },
    ]);
    const result = code.match("number", code.variant("T", tag, [num(1)]), [
      { tag, bindings: [parameter], body: body(inner) },
    ]);
    assert.equal(evaluate({ declarations: [{ binding: value, value: num(42) }], result }), 42);
  }
});

test("match validation enforces tag uniqueness, binding identity, and isolated scope", () => {
  const x = code.binding("x", "number");
  const matched = code.variant("T", "A", [num(1)]);
  assert.throws(
    () => code.validate(body(code.variant("T", "A", [code.ref(x)]))),
    /Out-of-scope binding/,
  );
  assert.throws(
    () => code.validate(body(code.match("number", code.ref(x), []))),
    /Out-of-scope binding/,
  );
  assert.throws(
    () =>
      code.validate(
        body(
          code.match("number", matched, [
            { tag: "A", bindings: [x], body: body(code.ref(x)) },
            { tag: "B", bindings: [], body: body(code.ref(x)) },
          ]),
        ),
      ),
    /Out-of-scope binding/,
  );
  assert.throws(
    () =>
      code.validate(
        body(
          code.match("number", matched, [{ tag: "A", bindings: [x], body: body(code.ref(x)) }], {
            body: body(code.ref(x)),
          }),
        ),
      ),
    /Out-of-scope binding/,
  );
  assert.throws(
    () =>
      code.validate(
        body(
          code.match("number", matched, [
            { tag: "A", bindings: [x], body: body(num(1)) },
            { tag: "B", bindings: [x], body: body(num(2)) },
          ]),
        ),
      ),
    /Binding declared twice/,
  );
  assert.throws(
    () =>
      code.validate(
        body(
          code.match("number", matched, [
            { tag: "A", bindings: [], body: body(num(1)) },
            { tag: "A", bindings: [], body: body(num(2)) },
          ]),
        ),
      ),
  );
  assert.throws(
    () =>
      code.validate({
        declarations: [{ binding: x, value: num(1) }],
        result: code.match("number", matched, [], { binding: x, body: body(code.ref(x)) }),
      }),
    /Binding declared twice/,
  );
});
