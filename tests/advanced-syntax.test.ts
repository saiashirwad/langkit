import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight } from "langkit/analysis";
import { program, tokens, type Expr } from "../examples/advanced/advanced-syntax.ts";

const parsed = (source: string) => {
  const result = program.parse(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  return result.value;
};

const expr = (source: string): Expr => parsed(source).body;

test("advanced syntax: datatype declarations, fields, parameters, and exact name spans", () => {
  const source = "type Option(a) = None | Some(a)\ntype Color = Red | Blue; Some(42)";
  const module = parsed(source);
  assert.equal(module.types.length, 2);
  const option = module.types[0]!;
  assert.equal(option.name, "Option");
  assert.deepEqual(option.parameters, ["a"]);
  assert.deepEqual(option.nameSpan, { start: 5, end: 11 });
  assert.deepEqual(
    option.constructors.map((c) => [c.name, c.fields.length]),
    [
      ["None", 0],
      ["Some", 1],
    ],
  );
  for (const declaration of module.types) {
    assert.equal(
      source.slice(declaration.nameSpan.start, declaration.nameSpan.end),
      declaration.name,
    );
    for (const constructor of declaration.constructors)
      assert.equal(
        source.slice(constructor.nameSpan.start, constructor.nameSpan.end),
        constructor.name,
      );
  }
  assert.deepEqual(module.types[1]!.parameters, []);
  assert.equal(module.body.kind, "call");
});

test("advanced syntax: recursive datatype fields and named type arguments", () => {
  const declaration = parsed("type List(a) = Nil | Cons(a, List(a)) Nil").types[0]!;
  const recursive = declaration.constructors[1]!.fields[1]!;
  assert.equal(recursive.kind, "name");
  if (recursive.kind === "name") {
    assert.equal(recursive.name, "List");
    assert.equal(recursive.args[0]!.kind, "name");
  }
});

test("advanced syntax: annotated recursive lets and right-associative type arrows", () => {
  const result = expr("let rec f: number -> boolean -> number = fn(x) => fn(y) => x in f(1)(true)");
  assert.equal(result.kind, "let");
  if (result.kind !== "let") return;
  assert.equal(result.recursive, true);
  assert.equal(result.annotation?.kind, "function");
  if (result.annotation?.kind === "function") {
    assert.equal(result.annotation.param.kind, "name");
    assert.equal(result.annotation.result.kind, "function");
  }
  const plain = expr("let x = 1 in x");
  assert.equal(plain.kind, "let");
  if (plain.kind === "let") {
    assert.equal(plain.recursive, false);
    assert.equal(plain.annotation, undefined);
    assert.ok(Object.hasOwn(plain, "annotation"));
  }
});

test("advanced syntax: higher-rank parameter annotations and grouped expression ascription", () => {
  const result = expr("fn(f: forall a b. a -> b -> a) => (f : (forall a b. a -> b -> a))");
  assert.equal(result.kind, "fn");
  if (result.kind !== "fn") return;
  assert.equal(result.annotation?.kind, "forall");
  if (result.annotation?.kind === "forall")
    assert.deepEqual(result.annotation.parameters, ["a", "b"]);
  assert.equal(result.body.kind, "annotated");
  if (result.body.kind === "annotated") assert.equal(result.body.annotation.kind, "forall");
  const source = "(fn(x) => x : forall a. a -> a)";
  const ascribed = expr(source);
  assert.equal(ascribed.kind, "annotated");
  assert.deepEqual(ascribed.span, { start: 0, end: source.length });
});

test("advanced syntax: parenthesized function domains and closed record annotations", () => {
  const result = expr("fn(f: (number -> number) -> {x: number, flag: boolean,}) => f");
  assert.equal(result.kind, "fn");
  if (result.kind !== "fn" || result.annotation?.kind !== "function") return;
  assert.equal(result.annotation.param.kind, "function");
  assert.equal(result.annotation.result.kind, "record");
  if (result.annotation.result.kind === "record")
    assert.deepEqual(
      result.annotation.result.fields.map((f) => f.name),
      ["x", "flag"],
    );
});

test("advanced syntax: constructor patterns, wildcard payloads, binding fallback and trailing comma", () => {
  const source = "match value { None => 0, Some(x, _) => x, rest => 1, }";
  const result = expr(source);
  assert.equal(result.kind, "match");
  if (result.kind !== "match") return;
  assert.equal(result.cases.length, 3);
  const some = result.cases[1]!.pattern;
  assert.equal(some.kind, "constructor");
  if (some.kind === "constructor") {
    assert.deepEqual(
      some.fields.map((f) => f.name),
      ["x", "_"],
    );
    for (const field of some.fields)
      assert.equal(source.slice(field.span.start, field.span.end), field.name);
  }
  assert.equal(result.cases[2]!.pattern.kind, "binding");
  assert.equal(expr("match value { _ => 1 }").kind, "match");
});

test("advanced syntax: calls and fields bind tighter than arithmetic; comma calls curry", () => {
  const result = expr("f(1, 2).x + 3 * 4 - 5");
  assert.equal(result.kind, "binary");
  if (result.kind !== "binary") return;
  assert.equal(result.op, "-");
  assert.equal(result.left.kind, "binary");
  if (result.left.kind !== "binary") return;
  assert.equal(result.left.op, "+");
  assert.equal(result.left.right.kind, "binary");
  assert.equal(result.left.left.kind, "field");
  if (result.left.left.kind !== "field") return;
  const call = result.left.left.record;
  assert.equal(call.kind, "call");
  if (call.kind === "call") assert.equal(call.fn.kind, "call");
});

test("advanced syntax: rows records, grouping, and nested match expressions", () => {
  const result = expr("{ x = match r.x { Some(v) => v, None => 0 } | r }");
  assert.equal(result.kind, "record");
  if (result.kind === "record") {
    assert.equal(result.fields[0]!.value.kind, "match");
    assert.equal(result.base?.kind, "name");
  }
  assert.equal(
    expr("(match x { Some(y) => match y { Some(z) => z, _ => 0 }, _ => 0 }) + 1").kind,
    "binary",
  );
});

test("advanced syntax: comments are trivia and do not highlight their contents", () => {
  const source =
    '// type Fake = Bogus\ntype Option(a) = None // comment\n| Some(a)\nlet x = "// not a comment" in // ignored\nx';
  const result = parsed(source);
  assert.equal(result.types.length, 1);
  assert.equal(result.body.kind, "let");
  const highlighted = highlight(source, tokens);
  assert.ok(highlighted.every((token) => token.span.start >= source.indexOf("\n") + 1));
  assert.equal(highlighted.filter((token) => token.kind === "string").length, 1);
  assert.equal(parsed("42 // final comment").body.kind, "number");
});

test("advanced syntax: JSON string escapes decode without raw controls", () => {
  const result = expr('"quote: \\" slash: \\\\ unicode: \\u0041\\n"');
  assert.equal(result.kind, "string");
  if (result.kind === "string") assert.equal(result.value, 'quote: " slash: \\ unicode: A\n');
});

for (const source of [
  "",
  "type Option(a) =",
  "type Option() = None None",
  "type Option(a) = None | 1",
  "type lower = Bad Bad",
  "type Option(A) = None None",
  "type Option(a) = some(a) None",
  "let rec = 1 in 1",
  "let type = 1 in type",
  "fn(x: forall . x) => x",
  "fn(x: number ->) => x",
  "fn(x: {x: number | r}) => x",
  "fn(x: Option()) => x",
  "match x { Some(Some(y)) => y }",
  "match x { Some(1) => 1 }",
  "match x { some(y) => y }",
  "match x { Some(X) => X }",
  "match x { None => }",
  "match x { None 1 }",
  "f()",
  "f(1,)",
  "(x :)",
  "x : number",
  "{x = 1 | }",
  "1 garbage",
  '"bad\\q"',
  '"bad\\u12"',
  '"unterminated',
  '"raw\nnewline"',
  '"raw\tcontrol"',
  '"raw\u0000control"',
]) {
  test(`advanced syntax rejects ${JSON.stringify(source)}`, () => {
    const result = program.parse(source);
    assert.equal(result.success, false);
    if (!result.success) {
      const span = result.error.diagnostic.span;
      assert.ok(span && span.start >= 0 && span.end <= source.length);
    }
  });
}
