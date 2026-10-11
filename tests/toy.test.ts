import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { analyze, compile, show } from "../examples/toy/toy.ts";
import { render } from "langkit";

const compiled = (source: string) => {
  const result = compile(source);
  if (!result.success) assert.fail(result.errors.map((error) => render(error, source)).join("\n"));
  return result.value;
};

const evaluate = (source: string): unknown =>
  runInNewContext(compiled(source).javascript, {}, { timeout: 1000 });


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
    assert.equal(result.errors[0]!.message, message);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.span);
    assert.match(result.errors.map((error) => render(error, source)).join("\n"), /\^/);
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
  assert.equal(source.slice(result.errors[0]!.span!.start, result.errors[0]!.span!.end), "true");
  assert.match(result.errors.map((error) => render(error, source)).join("\n"), /line 2, column 5/);
});

test("reports independent operand mismatches to compilation and analysis", () => {
  const source = "true + false";
  const compiledResult = compile(source);
  assert.equal(compiledResult.success, false);
  if (compiledResult.success) return;
  assert.equal(compiledResult.errors.length, 2);
  assert.deepEqual(compiledResult.errors.map((error) => source.slice(error.span!.start, error.span!.end).trim()), ["true", "false"]);
  const rendered = compiledResult.errors.map((error) => render(error, source)).join("\n");
  assert.match(rendered, /line 1, column 1/);
  assert.match(rendered, /line 1, column 8/);
  assert.equal("value" in compiledResult, false);
  assert.equal("javascript" in compiledResult, false);

  const analysis = analyze(source);
  assert.equal(analysis.diagnostics.length, 2);
  assert.deepEqual(analysis.diagnostics.map((error) => source.slice(error.span!.start, error.span!.end).trim()), ["true", "false"]);
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
