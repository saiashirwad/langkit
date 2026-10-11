import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "langkit";
import { definitionAt, semanticTokens, typeAt } from "langkit/analysis";
import { analyze, compile, elaborateBody, program, show } from "../examples/hm/hm.ts";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.errors[0]!.message);
  return result.value;
};



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
    if (!result.success) assert.match(result.errors.map((error) => error.message).join("\n"), /Cannot unify/);
  });
}

for (const source of ["fn(x) => x(x)", "fn(f) => fn(x) => let y = f(x) in f(f)"]) {
  test(`HM occurs check: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.errors.map((error) => error.message).join("\n"), /Infinite type/);
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
    if (!result.success) assert.match(result.errors.map((error) => error.message).join("\n"), /Unbound variable/);
  });
}

test("HM operand type errors keep the offending source span", () => {
  const result = compile("1 + true");
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.errors[0]!.span, { start: 4, end: 8 });
});

test("HM reusable elaboration and independent analyses allocate fresh inference variables", () => {
  const parsed = program.parse("fn(x) => x");
  assert.ok(parsed.success);
  const computation = elaborateBody(parsed.value);
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

test("HM reports independent constraints and preserves inference state after a partial mismatch", () => {
  const invalidSource = "true + false";
  const independent = compile(invalidSource);
  assert.equal(independent.success, false);
  if (!independent.success) {
    assert.equal(independent.errors.length, 2);
    assert.deepEqual(independent.errors.map((error) => {
      assert.ok(error.span);
      return invalidSource.slice(error.span.start, error.span.end).trim();
    }), ["true", "false"]);
  }

  const source = "fn(f) => let first = f(fn(x) => x + 1) in f(fn(y) => true)";
  const analysis = analyze(source);
  assert.equal(analysis.diagnostics.length, 1);
  assert.equal(show(typeAt(analysis, source.indexOf("y)"))!.type), "a");
  assert.equal(compile(source).success, false);
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

test("HM polymorphic references preserve definition identity with independent use types", () => {
  const source = "let id = fn(x) => x in if id(true) then id(42) else 0";
  const analysis = analyze(source);
  const uses = analysis.references.filter((reference) => source.slice(reference.span.start, reference.span.end) === "id");
  assert.deepEqual(uses.map((reference) => show(typeAt(analysis, reference.span.start)!.type)), [
    "(boolean -> boolean)",
    "(number -> number)",
  ]);
  assert.equal(uses[0]!.id, uses[1]!.id);
  assert.equal(show(typeAt(analysis, source.indexOf("id =") + 5)!.type), "(a -> a)");
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
