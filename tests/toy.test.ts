import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { compile, show } from "../examples/toy/toy.ts";
import { render } from "langkit";

const compiled = (source: string) => {
  const result = compile(source);
  if (!result.success) assert.fail(render(result.error, source));
  return result.value;
};

const evaluate = (source: string): unknown =>
  runInNewContext(compiled(source).javascript, {}, { timeout: 1000 });

for (const [source, expected] of [
  ["20 + 2 * 11", 42],
  ["(20 + 2) * 2", 44],
  ["12 - 3 - 2", 7],
  ["12 / 3 / 2", 2],
  ["-2 * 3", -6],
  ["1 / 0", Infinity],
  ["0 / 0", NaN],
  ["-0", -0],
  ["true", true],
  ["false == false", true],
  ["1 == 2", false],
  ["if 2 > 1 then 42 else 0", 42],
  ["let x = 20 in let y = x + 1 in y + y", 42],
  ["let x = 1 in (let x = x + 1 in x) + x", 3],
  ["let x = 10 in let f = fn(y: number) => x + y in let x = 100 in f(2)", 12],
  ["let add = fn(x: number) => fn(y: number) => x + y in add(20)(22)", 42],
  [
    "let twice = fn(f: number -> number) => fn(x: number) => f(f(x)) in twice(fn(x: number) => x + 1)(40)",
    42,
  ],
  ["(fn(x: boolean) => if x then 1 else 0)(true)", 1],
  ["(if true then fn(x: number) => x + 1 else fn(x: number) => x - 1)(41)", 42],
  ["(if false then let x = 10 in x else let x = 20 in x) + 2", 22],
  ["let constructor = 42 in constructor", 42],
  ["let __proto__ = 42 in __proto__", 42],
  ["let trueValue = 42 in trueValue", 42],
  ["\n  42  \n", 42],
] as const) {
  test(source, () => assert.equal(evaluate(source), expected));
}

for (const [source, message] of [
  ["true + 1", "Expected number, found boolean"],
  ["if 1 then 2 else 3", "Expected boolean, found number"],
  ["if true then 1 else false", "Expected number, found boolean"],
  ["(fn(x: number) => x)(false)", "Expected number, found boolean"],
  ["1(2)", "Expected a function, found number"],
  ["missing", "Unbound variable: missing"],
  ["let x = x in x", "Unbound variable: x"],
  ["(let x = 1 in x) + x", "Unbound variable: x"],
  ["if true then let x = 1 in x else x", "Unbound variable: x"],
  ["(fn(x: number) => x) == (fn(x: number) => x)", "Functions cannot be compared"],
  ["true == 1", "Expected boolean, found number"],
  [
    "(fn(f: number -> number) => f(1))(fn(x: boolean) => 1)",
    "Expected (number -> number), found (boolean -> number)",
  ],
] as const) {
  test(`rejects ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.error.message, message);
    assert.ok(result.error.span);
    assert.match(render(result.error, source), /\^/);
  });
}

for (const source of [
  "",
  "let x = in x",
  "fn(x) => x",
  "if true then 1",
  "1 +",
  "1 garbage",
  "let true = 1 in true",
  "fn(x: number) =>",
  "truefalse",
]) {
  test(`malformed or unbound: ${JSON.stringify(source)}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
  });
}

test("reports the offending operand's source location", () => {
  const source = "let x = 1 in\nx + true";
  const result = compile(source);
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(source.slice(result.error.span!.start, result.error.span!.end), "true");
  assert.match(render(result.error, source), /line 2, column 5/);
});

test("IR carries the language's inferred function type and source origin", () => {
  const result = compiled("fn(x: number) => x > 0");
  assert.equal(show(result.type), "(number -> boolean)");
  assert.equal(result.ir.body.result.node.kind, "fn");
  assert.deepEqual(result.ir.body.result.span, { start: 0, end: 22 });
});

test("compilation is repeatable and failures do not leak state", () => {
  const source = "let x = 40 in x + 2";
  const first = compiled(source).javascript;
  assert.equal(compile("let x = true in x + 1").success, false);
  assert.equal(compiled(source).javascript, first);
  assert.equal(evaluate(source), 42);
});
