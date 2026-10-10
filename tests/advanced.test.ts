import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { run } from "langkit";
import { create, validate } from "langkit/ir";
import { definitionAt, typeAt } from "langkit/analysis";
import {
  analyze,
  compile as compileSource,
  elaborate,
  program,
  show,
  type Type,
} from "../examples/advanced/advanced.ts";

const read = (uri: string): string => readFileSync(new URL(uri), "utf8");

const compile = (source: string) =>
  compileSource('import "./stdlib.advanced";\n' + source, {
    uri: new URL("../examples/advanced/test.advanced", import.meta.url).href,
    read,
  });

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  validate(result.value.ir);
  return result.value;
};

const evaluate = (source: string, log: (value: unknown) => void = () => {}) =>
  runInNewContext(compiled(source).javascript, { console: { log } }, { timeout: 1000 });

for (const [source, expected] of [
  ["let id = fn(x) => x in if id(true) then id(42) else 0", 42],
  [
    "let get = fn(r) => r.x in let a = get({ x = true }) in if a then get({ x = 42, y = 1 }) else 0",
    42,
  ],
  ["let add = fn(r) => { flag = true | r } in add({ x = 42 }).x", 42],
  ["let both = fn(f: forall a. a -> a) => if f(true) then f(42) else 0 in both(id)", 42],
  ["(fn(f: forall a. a -> a) => if f(true) then f(42) else 0)(fn(x) => x)", 42],
  [
    "let apply: (forall a. a -> a) -> number = fn(f) => if f(true) then f(42) else 0 in apply(id)",
    42,
  ],
  ["let identity: forall a. a -> a = fn(x) => x in if identity(true) then identity(42) else 0", 42],
  ["let identity = (fn(x) => x : forall a. a -> a) in identity(42)", 42],
  ["let make: number -> (forall a. a -> a) = fn(ignored) => fn(x) => x in make(0)(42)", 42],
  [
    "let use = fn(f: forall a. a -> a) => let alias = f in if alias(true) then alias(42) else 0 in use(id)",
    42,
  ],
  [
    "let use: ((forall a. a -> a) -> number) -> number = fn(g) => g(id) in use(fn(f) => if f(true) then f(42) else 0)",
    42,
  ],
  [
    "type Nest(a) = Done(a) | More(Nest(List(a))) let rec depth: forall a. Nest(a) -> number = fn(n) => match n { Done(_) => 0, More(rest) => 1 + depth(rest) } in depth(More(Done(Cons(42, Nil))))",
    1,
  ],
  ["let rec factorial = fn(n) => if n == 0 then 1 else n * factorial(n - 1) in factorial(5)", 120],
  [
    "let rec factorial: number -> number = fn(n) => if n == 0 then 1 else n * factorial(n - 1) in factorial(5)",
    120,
  ],
  [
    "let rec identity: forall a. a -> a = fn(x) => if true then x else identity(x) in if identity(true) then identity(42) else 0",
    42,
  ],
  ["type Color = Red | Blue match Red { Red => 42, Blue => 0 }", 42],
  [
    "type Box(a) = Box(a) let unbox = fn(box) => match box { Box(value) => value } in unbox(Box(42))",
    42,
  ],
  [
    "type Tree(a) = Leaf(a) | Branch(Tree(a), Tree(a)) let rec sum = fn(tree) => match tree { Leaf(x) => x, Branch(a, b) => sum(a) + sum(b) } in sum(Branch(Leaf(20), Leaf(22)))",
    42,
  ],
  [
    "type A = A(B) type B = B | More(A) match A(B) { A(value) => match value { B => 42, More(_) => 0 } }",
    42,
  ],
  ["match Some(42) { None => 0, Some(x) => x }", 42],
  ["match Some(42) { None => 0, other => match other { None => 1, Some(x) => x } }", 42],
  ["match 42 { value => value }", 42],
  ["match true { _ => 42 }", 42],
  ["let get = fn(option) => match option { Some(x) => x, None => 0 } in get(Some(42))", 42],
  ["withDefault(0)(mapOption(fn(x) => x + 1)(Some(41)))", 42],
  ["withDefault(42)(None)", 42],
  ["match mapResult(fn(x) => x + 1)(Ok(41)) { Ok(value) => value, Err(_) => 0 }", 42],
  ["match andThen(fn(x) => Ok(x + 1))(Ok(41)) { Ok(value) => value, Err(_) => 0 }", 42],
  ["foldList(fn(sum) => fn(x) => sum + x)(0)(mapList(fn(x) => x * 2)(range(1)(6)))", 42],
  ["length(append(range(1)(20))(range(1)(22)))", 42],
  ["withDefault(0)(head(Cons(42, Nil)))", 42],
  [
    "let first = fn(xs) => match xs { Nil => None, Cons(x, _) => Some(x) } in withDefault(0)(first(Cons(42, Nil)))",
    42,
  ],
  ["let print = fn(x) => x in print(42)", 42],
  ["{ __proto__ = 42 }.__proto__", 42],
] as const) {
  test(`advanced execution: ${source}`, () => assert.equal(evaluate(source), expected));
}

for (const [source, expected] of [
  ["fn(x) => x", "(a -> a)"],
  ["fn(r) => r.x", "({ x: a | r } -> a) where r lacks x"],
  ["Some(42)", "Option(number)"],
  ["Cons(true, Nil)", "List(boolean)"],
  ["mapList(fn(x) => x + 1)(Nil)", "List(number)"],
  [
    "let rec count = fn(xs) => match xs { Nil => 0, Cons(_, rest) => 1 + count(rest) } in count",
    "(List(a) -> number)",
  ],
] as const) {
  test(`advanced inferred type: ${source}`, () =>
    assert.equal(show(compiled(source).type), expected));
}

test("advanced higher-rank type retains the parameter's quantifier", () => {
  const type = show(compiled("fn(f: forall a. a -> a) => if f(true) then f(42) else 0").type);
  assert.match(type, /forall/);
  assert.match(type, /number/);
});

for (const [source, message] of [
  [
    "let both = fn(f: forall a. a -> a) => if f(true) then f(42) else 0 in both(fn(x) => x + 1)",
    /unify|rigid|skolem|polymorph/i,
  ],
  ["let bad: forall a. a -> a = fn(x) => 1 in bad(true)", /unify|rigid|skolem/i],
  ["fn(x) => (x : forall a. a)", /escape|rigid|skolem/i],
  ["fn(f) => (f : forall a. a -> a)", /escape|rigid|skolem/i],
  ["fn(r) => (r.x : forall a. a)", /escape|rigid|skolem/i],
  ["fn(f) => let g = f in let a = g(1) in g(true)", /unify/i],
  ["fn(x) => x(x)", /Infinite type/],
  ["let rec bad = bad in bad", /function initializer/],
  ["let rec bad = { x = bad } in bad", /function initializer/],
  ["let rec f = fn(x) => if true then f(1) else f(true) in f", /unify/i],
  [
    "type Nest(a) = Done(a) | More(Nest(List(a))) let rec depth = fn(n) => match n { Done(_) => 0, More(rest) => 1 + depth(rest) } in depth",
    /Infinite type/,
  ],
  ["type A = A type B = B if true then A else B", /unify|nominal/i],
  ["match Some(1) { Some(x) => x }", /Non-exhaustive.*None/],
  ["match None { None => 0, None => 1, Some(_) => 2 }", /duplicate case/],
  ["match None { _ => 0, Some(_) => 1 }", /Unreachable/],
  ["match Some(1) { None => 0, Some(x, y) => x }", /expects 1 fields/],
  ["match Cons(1, Nil) { Nil => 0, Cons(x, x) => x }", /Duplicate pattern binding/],
  ["match Some(1) { Nil => 0, Some(x) => x }", /unify|nominal/i],
  ["match Some(1) { None => true, Some(x) => x }", /unify/i],
  ["match None { Unknown => 0 }", /Unknown constructor/],
  ["match Some(1) { None => x, Some(x) => x }", /Unbound variable/],
  [
    "let get = fn(xs) => match xs { Nil => 0, Cons(x, _) => let a = x(1) in x(true) } in get",
    /unify/i,
  ],
  ["(fn(x: Missing) => x)(1)", /Unknown type/],
  ["(fn(x: Option) => x)(None)", /expects 1 arguments/],
  ["(fn(x: number(boolean)) => x)(1)", /takes no arguments/],
  ["(fn(x: List(forall a. a -> a)) => x)(Nil)", /Polymorphic data arguments/],
  ["(fn(x: { f: forall a. a -> a }) => x)({ f = id })", /Polymorphic record fields/],
  ["type Box(a, a) = Box(a) Box(1)", /Duplicate type parameter/],
  ["type Box(a) = Box(b) Box(1)", /Unknown type/],
  ["type Box = Box type Box = Another Box", /Duplicate type/],
  ["type Box = Same type Other = Same Same", /Duplicate constructor/],
  ["type Option(a) = Another(a) Another(1)", /Duplicate type/],
  ["{ x = 1 | { x = true } }", /Duplicate field/],
  ["fn(r) => if true then r else { x = 1 | r }", /Infinite row/],
  [
    "(fn(r) => fn(s) => (if false then { x = r, y = 1 | s } else { x = { y = true | s } | r }).y)({ y = true })({})",
    /unify/i,
  ],
] as const) {
  test(`advanced rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  });
}

for (const source of [
  "",
  "type",
  "match None {}",
  "fn(x:) => x",
  "(1 :)",
  '"bad\\q"',
  '"raw\tcontrol"',
]) {
  test(`advanced malformed input: ${JSON.stringify(source)}`, () =>
    assert.equal(compile(source).success, false));
}

test("advanced matching evaluates the scrutinee once and only the chosen branch", () => {
  const output: unknown[] = [];
  const value = evaluate(
    "match (let ignored = print(1) in Some(42)) { None => let ignored = print(2) in 0, Some(x) => let ignored = print(3) in x }",
    (value) => output.push(value),
  );
  assert.equal(value, 42);
  assert.deepEqual(output, [1, 3]);
});

test("advanced constructor fields and record extension preserve effect order", () => {
  const output: unknown[] = [];
  evaluate(
    "type Pair(a, b) = Pair(a, b) let pair = Pair(print(1), print(2)) in { x = print(3) | (let ignored = print(4) in {}) }",
    (value) => output.push(value),
  );
  assert.deepEqual(output, [1, 2, 3, 4]);
});

test("advanced sample exercises datatypes, recursion, rows, higher rank, lists and print", () => {
  const output: unknown[] = [];
  assert.equal(
    evaluate(
      readFileSync(new URL("../examples/advanced/main.advanced", import.meta.url), "utf8"),
      (value) => output.push(value),
    ),
    49,
  );
  assert.deepEqual(output, ["The answer is:", 49]);
});

test("advanced analysis excludes stdlib facts and keeps pattern definitions", () => {
  const source = 'import "./stdlib.advanced";\nmatch Some(42) { None => 0, Some(value) => value }';
  const analysis = analyze(source, {
    uri: new URL("../examples/advanced/test.advanced", import.meta.url).href,
    read,
  });
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.definitions.filter((definition) => !definition.uri).length, 1);
  assert.equal(show(typeAt(analysis, source.lastIndexOf("value"))!.type), "number");
  assert.equal(
    definitionAt(analysis, source.lastIndexOf("value"))?.span.start,
    source.indexOf("value"),
  );
  assert.deepEqual(analyze('print("hello")').diagnostics, []);
});

test("advanced user constructors and recursive calls retain definition identity", () => {
  const source = "type Box(a) = Box(a) let rec f = fn(x) => if true then Box(x) else f(x) in f(42)";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(
    definitionAt(analysis, source.indexOf("Box(x)"))?.span.start,
    source.indexOf("Box(a)", source.indexOf("=") + 1),
  );
  assert.equal(definitionAt(analysis, source.indexOf("f(x)"))?.span.start, source.indexOf("f ="));
});

test("advanced independent checks do not retain metas, skolems or nominal declarations", () => {
  const parsed = program.parse("fn(r) => r.x");
  assert.ok(parsed.success);
  const code = create<Type>();
  const computation = code.body(elaborate(parsed.value.body));
  const first = run(computation);
  const second = run(computation);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value.result.type, second.value.result.type);
  assert.equal(show(first.value.result.type), show(second.value.result.type));
  const before = analyze("fn(r) => r.x");
  compile("fn(f) => (f : forall a. a -> a)");
  compiled("type Private = Private Private");
  assert.equal(compile("Private").success, false);
  assert.equal(show(typeAt(before, 3)!.type), "{ x: a | r } where r lacks x");
});
