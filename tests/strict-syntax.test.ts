import assert from "node:assert/strict";
import { test } from "node:test";
import { highlight } from "langkit/analysis";
import { program, tokens, type Expr, type TypeExpr } from "../examples/strict/strict-syntax.ts";

const parsed = (source: string) => {
  const result = program.parse(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  return result.value;
};

const expression = (source: string): Expr => {
  const body = parsed(source).body;
  assert.ok(body);
  return body;
};

const type = (source: string): TypeExpr => parsed(`f : ${source};`).signatures[0]!.type;

for (const source of [
  "42",
  "true",
  '"hello\\nworld"',
  "-2",
  "f x y",
  "f (-1)",
  "f x + 2 * 3",
  "let f x y = x + y in f 20 22",
  "let rec f x = if x == 0 then 0 else f (x - 1) in f 3",
  "let f : number -> number = \\x -> x in f 42",
  "\\x y -> x",
  "\\(f : forall a. a -> a) -> f true",
  "(f : forall a. a -> a)",
  "{x = 1, flag = true | rest}",
  "{}.x",
  "f r.x",
  "(f r).x",
  "case value of { None -> 0; Some x -> x; }",
  "case value of { Cons x _ -> x; Nil -> 0 }",
  "case value of { other -> other }",
  "case value of { _ -> 0 }",
  "do { x <- pure 1; let y = x + 1; print y; pure y; }",
  "do { pure {} }",
  "do {}",
  "case value of {}",
]) {
  test(`strict syntax expression: ${source}`, () => {
    expression(source);
  });
}

for (const source of [
  "data Option a = None | Some a; main = Some 42;",
  "data List a = Nil | Cons a (List a); data Box a = Box a; main = Box Nil;",
  "data Pair a b = Pair a b; Pair 1 true",
  "data Box f a = Box (f a); main = Box (Some 1);",
  "class Eq a where { eq : a -> a -> boolean; }",
  "class Eq a where { eq : a -> a -> boolean }",
  "class Eq a where { eq : a -> a -> boolean; neq : a -> a -> boolean }",
  "class Functor (f : Type -> Type) where { map : forall a b. (a -> b) -> f a -> f b; }",
  "class H (f : (Type -> Type) -> Type -> Type) where { use : forall g a. f g a -> number; };",
  "instance Functor Option where { map f option = case option of { None -> None; Some x -> Some (f x); }; }",
  "instance Eq number where { eq x y = x == y }",
  "identity : forall a. a -> a; identity x = x; main = identity 42;",
  "rec factorial n = if n == 0 then 1 else n * factorial (n - 1); factorial 5",
  "main = do { print 42; pure {}; };",
  "// first\ndata Color = Red | Blue; -- second\nmain = Red;",
]) {
  test(`strict syntax module: ${source}`, () => {
    parsed(source);
  });
}

for (const source of [
  "number",
  "a -> b -> a",
  "List number",
  "Result a e",
  "f a",
  "f (g a)",
  "forall a b. (a -> b) -> a -> b",
  "(forall a. a -> a) -> number",
  "Eq a => a -> boolean",
  "(Eq a) => a -> boolean",
  "(Eq a, Other b) => a -> b",
  "forall f a b. Functor f => (a -> b) -> f a -> f b",
  "{ x: number, f: a -> b }",
]) {
  test(`strict syntax type: ${source}`, () => {
    type(source);
  });
}

test("strict application is left associative and binds tighter than numeric operators", () => {
  const value = expression("f x y + 2 * 3");
  assert.equal(value.kind, "binary");
  if (value.kind !== "binary") return;
  assert.equal(value.op, "+");
  assert.equal(value.left.kind, "call");
  if (value.left.kind === "call") {
    assert.equal(value.left.fn.kind, "call");
    assert.equal(value.left.arg.kind, "name");
    if (value.left.arg.kind === "name") assert.equal(value.left.arg.name, "y");
  }
  assert.equal(value.right.kind, "binary");
  if (value.right.kind === "binary") assert.equal(value.right.op, "*");
});

test("strict subtraction is never parsed as an application to a negative literal", () => {
  for (const source of ["2 - 1", "2-1", "f x - 1", "2 -1"]) {
    const value = expression(source);
    assert.equal(value.kind, "binary");
    if (value.kind === "binary") assert.equal(value.op, "-");
  }
  const call = expression("f (-1)");
  assert.equal(call.kind, "call");
  if (call.kind === "call") {
    assert.equal(call.arg.kind, "number");
    if (call.arg.kind === "number") assert.equal(call.arg.value, -1);
  }
});

test("strict declarations preserve field boundaries, binding spans, and expression bodies", () => {
  const source =
    "data List a = Nil | Cons a (List a); rec length xs = case xs of { Nil -> 0; Cons _ rest -> 1 + length rest }; length Nil";
  const module = parsed(source);
  assert.equal(module.types[0]!.constructors[1]!.fields.length, 2);
  assert.equal(module.types[0]!.constructors[1]!.fields[1]!.kind, "name");
  const second = module.types[0]!.constructors[1]!.fields[1]!;
  if (second.kind === "name") {
    assert.equal(second.name, "List");
    assert.equal(second.args.length, 1);
  }
  const binding = module.bindings[0]!;
  assert.equal(binding.recursive, true);
  assert.equal(source.slice(binding.nameSpan.start, binding.nameSpan.end), "length");
  assert.equal(binding.value.kind, "fn");
  assert.equal(module.body?.kind, "call");
});

test("strict method equations desugar arguments and preserve explicit kinds", () => {
  const module = parsed(
    "class Functor (f : Type -> Type) where { map : forall a b. (a -> b) -> f a -> f b; } instance Functor Option where { map f x = f x; }",
  );
  const cls = module.classes[0]!;
  assert.equal(cls.parameter.kind?.kind, "arrow");
  assert.equal(cls.methods[0]!.type.kind, "forall");
  const method = module.instances[0]!.methods[0]!;
  assert.equal(method.value.kind, "fn");
  if (method.value.kind === "fn") {
    assert.equal(method.value.param, "f");
    assert.equal(method.value.body.kind, "fn");
  }
});

test("strict qualified types preserve constraints separately from function arrows", () => {
  const value = type("forall a b. (Eq a, Other (List b)) => a -> b");
  assert.equal(value.kind, "forall");
  if (value.kind !== "forall") return;
  assert.equal(value.body.kind, "qualified");
  if (value.body.kind !== "qualified") return;
  assert.deepEqual(
    value.body.predicates.map((predicate) => predicate.className),
    ["Eq", "Other"],
  );
  assert.equal(value.body.type.kind, "function");
  const arg = value.body.predicates[1]!.arg;
  assert.equal(arg.kind, "name");
  if (arg.kind === "name") {
    assert.equal(arg.name, "List");
    assert.equal(arg.args.length, 1);
  }
});

test("strict do steps distinguish action, binding, and pure local let", () => {
  const source = "do { x <- pure 1; let y = x + 1; print y; pure y; }";
  const value = expression(source);
  assert.equal(value.kind, "do");
  if (value.kind !== "do") return;
  assert.deepEqual(
    value.steps.map((step) => step.kind),
    ["bind", "let", "action", "action"],
  );
  const first = value.steps[0]!;
  if (first.kind === "bind")
    assert.equal(source.slice(first.nameSpan.start, first.nameSpan.end), "x");
});

test("strict comments are trivia without highlighting fake declarations", () => {
  const source = '// data Fake = Fake;\nmain = "-- not a comment"; -- ignored\n';
  const module = parsed(source);
  assert.equal(module.types.length, 0);
  assert.equal(module.bindings.length, 1);
  const spans = highlight(source, tokens);
  assert.deepEqual(
    spans.map((token) => source.slice(token.span.start, token.span.end)),
    ["main", "=", '"-- not a comment"'],
  );
});

for (const source of [
  "data",
  "data Option a = None |;",
  "data lower = Bad;",
  "data Box a = Box (List a;",
  "class Eq a where { eq : a ->; }",
  "class Functor (f : Type ->) where {}",
  "instance Functor where {}",
  "instance Functor Option where { map f =; }",
  "main =;",
  "main = 1",
  "rec f =;",
  "x : forall. number;",
  "x : Eq a =>;",
  "x : (Eq a,) => a;",
  "x : (a -> b;",
  "\\ -> 1",
  "\\(f :) -> f",
  "case x of { Some (Some x) -> x; }",
  "case x of { Some 1 -> 1; }",
  "case x of { Some x => x; }",
  "do { x <-; pure x; }",
  "do { let = 1; pure {}; }",
  "do { print 1 print 2;",
  '"bad\\q"',
  '"raw\tcontrol"',
  '"raw\u0000control"',
  "{x =}",
  "{x = 1 |}",
  "r.",
]) {
  test(`strict syntax rejects: ${JSON.stringify(source)}`, () =>
    assert.equal(program.parse(source).success, false));
}
