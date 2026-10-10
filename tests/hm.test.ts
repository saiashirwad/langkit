import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { run } from "langkit";
import { definitionAt, semanticTokens, typeAt } from "langkit/analysis";
import { create, validate, type Body, type Value } from "langkit/ir";
import { analyze, compile, elaborate, program, show, type Type } from "../examples/hm/hm.ts";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  validate(result.value.ir);
  return result.value;
};

const evaluate = (source: string): unknown =>
  runInNewContext(compiled(source).javascript, {}, { timeout: 1000 });

for (const [source, expected] of [
  ["fn(x) => x", "(a -> a)"],
  ["fn(x) => fn(y) => x", "(a -> (b -> a))"],
  ["fn(f) => fn(g) => fn(x) => f(g(x))", "((a -> b) -> ((c -> a) -> (c -> b)))"],
  ["fn(f) => fn(x) => f(f(x))", "((a -> a) -> (a -> a))"],
  ["fn(x) => x + 1", "(number -> number)"],
  ["fn(x) => if x then 1 else 2", "(boolean -> number)"],
  ["let id = fn(x) => x in id(id)", "(a -> a)"],
  ["fn(x) => let f = fn(y) => x in f", "(a -> (b -> a))"],
  ["fn(f) => let y = f(1) in y", "((number -> a) -> a)"],
] as const) {
  test(`HM principal type: ${source}`, () => {
    assert.equal(show(compiled(source).type), expected);
  });
}

for (const [source, expected] of [
  ["let id = fn(x) => x in if id(true) then id(42) else 0", 42],
  ["let id = fn(x) => x in let alias = id in if alias(true) then id(42) else 0", 42],
  ["let choose = fn(x) => fn(y) => x in choose(42)(true)", 42],
  ["let apply = fn(f) => fn(x) => f(x) in apply(fn(x) => x + 1)(41)", 42],
  ["let x = 10 in let f = fn(y) => x + y in let x = 100 in f(2)", 12],
  ["let x = 1 in (let x = x + 1 in x) + x", 3],
  ["(let x = 1 in x) + (let x = 2 in x)", 3],
  ["(if false then let x = 10 in x else let x = 20 in x) + 2", 22],
  ["if 2 > 1 then 42 else 0", 42],
  ["1 == 1", true],
  ["12 - 3 - 2", 7],
  ["-2 * 3", -6],
  ["let f = fn(x) => let g = fn(y) => x in let b = g(true) in g(1) in f(42)", 42],
  ["let constructor = 42 in constructor", 42],
] as const) {
  test(`HM execution: ${source}`, () => assert.equal(evaluate(source), expected));
}

test("HM sample is separate source and evaluates to 42", () => {
  const source = readFileSync(new URL("../examples/hm/main.hm", import.meta.url), "utf8");
  assert.equal(evaluate(source), 42);
});

for (const source of [
  "fn(f) => let x = f(1) in f(true)",
  // A lambda parameter's alias must not become polymorphic.
  "fn(f) => let g = f in let x = g(1) in g(true)",
  // Solving outer f exposes new free variables in its type. Neither y nor
  // variables captured by a generalized function may generalize these away.
  "fn(f) => let y = f(1) in if y then y + 1 else 0",
  "fn(f) => let g = fn(x) => f(x) in let a = g(1) in g(true)",
  "fn(x) => let g = fn(y) => x(y) in let a = g(1) in g(true)",
  "(fn(id) => if id(true) then id(1) else 0)(fn(x) => x)",
  "true + 1",
  "if 1 then 2 else 3",
  "if true then 1 else false",
  "1(2)",
  "true == false",
  "(fn(x) => x) == (fn(x) => x)",
]) {
  test(`HM rejects inconsistent constraints: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /Cannot unify/);
  });
}

for (const source of ["fn(x) => x(x)", "fn(f) => fn(x) => let y = f(x) in f(f)"]) {
  test(`HM occurs check: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /Infinite type/);
  });
}

for (const source of ["", "fn(x) =>", "let x = in x", "fn(x: number) => x", "1 garbage"]) {
  test(`HM syntax failure: ${JSON.stringify(source)}`, () =>
    assert.equal(compile(source).success, false));
}

for (const source of ["missing", "let x = x in x", "(let x = 1 in x) + x"]) {
  test(`HM lexical scope failure: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /Unbound variable/);
  });
}

test("HM operand type errors keep the offending source span", () => {
  const result = compile("1 + true");
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.span, { start: 4, end: 8 });
});

test("HM reusable elaboration and independent analyses allocate fresh inference variables", () => {
  const parsed = program.parse("fn(x) => x");
  assert.ok(parsed.success);
  const code = create<Type>();
  const computation = code.body(elaborate(parsed.value));
  const first = run(computation);
  const second = run(computation);
  assert.ok(first.success && second.success);
  assert.equal(show(first.value.result.type), "(a -> a)");
  assert.equal(show(second.value.result.type), "(a -> a)");
  assert.notEqual(first.value.result.type, second.value.result.type);
  assert.equal(first.value.result.type.kind, "function");
  assert.equal(second.value.result.type.kind, "function");
  if (first.value.result.type.kind === "function" && second.value.result.type.kind === "function") {
    assert.notEqual(first.value.result.type.param, second.value.result.type.param);
  }
  const previous = analyze("fn(x) => x");
  assert.equal(compile("fn(x) => x(x)").success, false);
  compiled("fn(x) => x + 1");
  assert.equal(show(typeAt(previous, 3)!.type), "a");
  assert.equal(show(compiled("fn(x) => x").type), "(a -> a)");
});

test("HM analysis distinguishes a generic declaration from instantiated uses", () => {
  const source = "let id = fn(x) => x in if id(true) then id(42) else 0";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const first = source.indexOf("id(true)");
  const second = source.indexOf("id(42)");
  assert.equal(show(typeAt(analysis, 4)!.type), "(a -> a)");
  assert.equal(show(typeAt(analysis, first)!.type), "(boolean -> boolean)");
  assert.equal(show(typeAt(analysis, second)!.type), "(number -> number)");
  assert.equal(definitionAt(analysis, first)?.id, definitionAt(analysis, second)?.id);
  assert.deepEqual(definitionAt(analysis, second)?.span, { start: 4, end: 6 });
  assert.equal(
    semanticTokens(analysis).find((token) => token.span.start === first)?.kind,
    "function",
  );
});

test("HM IR references preserve binding identity while carrying independent types", () => {
  const source = "let id = fn(x) => x in if id(true) then id(42) else 0";
  const uses: Value<Type>[] = [];
  const body = (body: Body<Type>): void => {
    for (const declaration of body.declarations) visit(declaration.value);
    visit(body.result);
  };
  const visit = (value: Value<Type>): void => {
    const node = value.node;
    switch (node.kind) {
      case "ref":
        if (node.binding.name === "id") uses.push(value);
        return;
      case "literal":
        return;
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "call":
        visit(node.fn);
        visit(node.arg);
        return;
      case "fn":
        body(node.body);
        return;
      case "block":
        body(node.body);
        return;
      case "if":
        visit(node.cond);
        body(node.then);
        body(node.else);
        return;
    }
  };
  body(compiled(source).ir);
  assert.deepEqual(
    uses.map((value) => show(value.type)),
    ["(boolean -> boolean)", "(number -> number)"],
  );
  assert.ok(uses[0]!.node.kind === "ref" && uses[1]!.node.kind === "ref");
  assert.equal(uses[0]!.node.binding, uses[1]!.node.binding);
  assert.equal(show(uses[0]!.node.binding.type), "(a -> a)");
});

test("HM hovers resolve later constraints on parameters and references", () => {
  const source = "fn(f) => fn(x) => f(x) + 1";
  const analysis = analyze(source);
  assert.equal(show(typeAt(analysis, source.indexOf("f)"))!.type), "(a -> number)");
  assert.equal(show(typeAt(analysis, source.lastIndexOf("f(x)"))!.type), "(a -> number)");
});

test("HM shadowing keeps definition identities distinct", () => {
  const source = "let x = 1 in (let x = true in x)";
  const analysis = analyze(source);
  assert.equal(
    definitionAt(analysis, source.lastIndexOf("x"))?.span.start,
    source.indexOf("x = true"),
  );
  assert.notEqual(analysis.definitions[0]!.id, analysis.definitions[1]!.id);
});

test("HM malformed input still highlights but does not expose stale semantic facts", () => {
  analyze("let id = fn(x) => x in id(1)");
  const analysis = analyze("let id = fn(x) =>");
  assert.equal(analysis.diagnostics.length, 1);
  assert.deepEqual(analysis.types, []);
  assert.deepEqual(analysis.references, []);
  assert.ok(analysis.tokens.some((token) => token.kind === "keyword"));
});

test("HM analysis retains completed expression facts after a checking failure", () => {
  const source = "let id = fn(x) => x in id(1) + true";
  const analysis = analyze(source);
  assert.equal(analysis.diagnostics.length, 1);
  assert.equal(show(typeAt(analysis, source.indexOf("id(1)"))!.type), "(number -> number)");
  assert.equal(definitionAt(analysis, source.indexOf("id(1)"))?.span.start, 4);
});
