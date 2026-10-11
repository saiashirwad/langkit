import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile as rawCompile, show } from "../examples/strict/strict.ts";

const withStdlib = (source: string) => `import "./examples/strict/stdlib.strict";\n${source}`;

const compile = (source: string) => rawCompile(withStdlib(source));

const compiled = (source: string, uri?: string) => {
  const result = uri ? rawCompile(source, { uri }) : compile(source);
  assert.ok(result.success, result.success ? "" : result.errors[0].message);
  return result.value;
};

const evaluate = (
  source: string,
  log: (value: unknown) => void = () => {},
  uri?: string,
): unknown =>
  runInNewContext(compiled(source, uri).javascript, { console: { log } }, { timeout: 1000 });

const execute = (
  source: string,
  log: (value: unknown) => void = () => {},
  uri?: string,
): unknown => {
  // Invoke inside the timed VM too; calling an unbounded source action outside
  // runInNewContext would not be protected by the evaluation timeout.
  const javascript = compiled(source, uri).javascript;
  return runInNewContext(`(${javascript})({})`, { console: { log } }, { timeout: 1000 });
};


for (const [source, message] of [
  ["main = map id 42;", /kind|unify|instance/i],
  ["data Box a = Box a; main = map id (Box 1);", /instance/i],
  ["main = map;", /ambig|constraint|instance/i],
  [
    "class Mystery a where { mystery : a -> number; } main = mystery (let rec loop x = loop x in loop {});",
    /ambig|constraint|instance/i,
  ],
  ["instance Functor Option where { map f x = x; } main = 0;", /overlap|duplicate/i],
  ["instance Functor number where { map f x = x; } main = 0;", /kind/i],
  [
    "class Select a where { select : a -> a; } instance Select List where { select x = x; } main = 0;",
    /kind/i,
  ],
  [
    "class Select a where { select : a -> a; } instance Select number where { select x = true; } main = 0;",
    /unify|skolem/i,
  ],
  [
    "class Select a where { select : a -> a; } instance Select number where { } main = 0;",
    /missing|method/i,
  ],
  [
    "class Select a where { select : a -> a; } instance Select number where { select x = x; extra x = x; } main = 0;",
    /extra|unknown|method/i,
  ],
  ["instance Missing number where { thing x = x; } main = 0;", /unknown|class/i],
  ["class Broken (f : Type -> Type) where { broken : f -> number; } main = 0;", /kind/i],
  ["bad : forall f. f f -> number; bad x = 0; main = 0;", /kind/i],
  ["bad : List -> number; bad x = 0; main = 0;", /kind/i],
  ["bad : number number; bad = 0; main = 0;", /kind/i],
  [
    "main = (\\(f : forall a. a -> a) -> if f true then f 42 else 0) (\\x -> x + 1);",
    /unify|rigid|skolem/i,
  ],
  ["main = \\x -> (x : forall a. a);", /escape|rigid|skolem/i],
  ["main = \\f -> let g = f in let a = g 1 in g true;", /unify/i],
  ["main = \\x -> x x;", /Infinite type/],
  ["main = { x = 1 | { x = true } };", /Duplicate field/],
  ["main = \\r -> if true then r else { x = 1 | r };", /Infinite row/],
  ["main = case Some 1 of { Some x -> x; };", /exhaustive|missing/i],
  ["main = case None of { _ -> 0; Some x -> x; };", /Unreachable/i],
  ["main = print 1 + 1;", /unify/i],
  ["main = (print 1) {};", /unify/i],
  ["main : Effect number; main = { run = \\x -> 42 };", /unify/i],
  ["main = do { 42; };", /unify|effect/i],
  ["main = do { x <- pure 42; };", /last|final|action/i],
  ["main = do { let x = 42; };", /last|final|action/i],
  ["main = do { x <- 42; pure x; };", /unify|effect/i],
  [
    "main = let action : Effect number = do { x <- pure 42; pure x; } in pure x;",
    /Unbound variable/,
  ],
] as const) {
  test(`strict rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false, result.success ? show(result.value.type) : "");
    if (!result.success) assert.match(result.errors[0].message, message);
  });
}

test("strict reports independent operand errors with source locations", () => {
  const result = compile('main = true + "not a number";');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.errors.length >= 2);
    assert.ok(result.errors.every((error) => error.span !== undefined));
  }
});

test("strict print constructs an opaque action without executing it", () => {
  const output: unknown[] = [];
  const action = evaluate('main = print "hello";', (value) => output.push(value));
  assert.equal(typeof action, "function");
  assert.equal(output.length, 0);
  assert.deepEqual(analyze(withStdlib('main = print "hello";')).diagnostics, []);
  assert.equal(output.length, 0);
  execute('main = print "hello";', (value) => output.push(value));
  assert.deepEqual(output, ["hello"]);
});

test("strict do sequencing binds results and runs each selected action once", () => {
  const output: unknown[] = [];
  const source =
    "main = do { print 1; x <- pure 20; let y = x + 22; if true then print y else print 0; pure y; };";
  assert.equal(typeof evaluate(source, (value) => output.push(value)), "function");
  assert.equal(output.length, 0);
  assert.equal(
    execute(source, (value) => output.push(value)),
    42,
  );
  assert.deepEqual(output, [1, 42]);
});

test("strict bind and pure execute delayed effects in order", () => {
  const output: unknown[] = [];
  const source =
    'main = bind (print "first") (\\ignored -> bind (pure 42) (\\value -> bind (print value) (\\ignored -> pure value)));';
  assert.equal(
    execute(source, (value) => output.push(value)),
    42,
  );
  assert.deepEqual(output, ["first", 42]);
});

test("strict unused actions never execute and do not turn pure results effectful", () => {
  const output: unknown[] = [];
  assert.equal(
    evaluate('unused = print "never"; main = const 42 unused;', (value) => output.push(value)),
    42,
  );
  assert.deepEqual(output, []);
  assert.equal(show(compiled("main = 42;").type), "number");
  assert.match(show(compiled("main : Effect number; main = pure 42;").type), /Effect.*number/);
});

test("strict evaluates ordinary function arguments eagerly", () => {
  // Divergence in an unused argument distinguishes strict from lazy evaluation.
  assert.throws(
    () => evaluate("rec loop x = loop x; main = const 42 (loop {});"),
    /stack|timed out/i,
  );
});

test("strict Functor instance methods are checked even if unused", () => {
  const source =
    "data Box a = Box a; instance Functor Box where { map f box = case box of { Box x -> Box true; }; } main = 42;";
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.errors[0].message, /unify|skolem|rigid/i);
});

test("strict constrained functions expose inferred predicates in analysis", () => {
  const source = withStdlib("bump xs = map (\\x -> x + 1) xs; main = bump (Some 41);");
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.match(show(typeAt(analysis, source.indexOf("bump"))!.type), /Functor/);
  assert.equal(
    definitionAt(analysis, source.lastIndexOf("bump"))?.span.start,
    source.indexOf("bump"),
  );
  assert.equal(
    analysis.definitions.some((definition) => definition.name === "mapList"),
    false,
  );
});

test("strict dictionary scopes do not leak between independent compilations", () => {
  const source =
    "class Select a where { select : a -> a; } instance Select number where { select x = x + 1; } main = select 41;";
  assert.equal(evaluate(source), 42);
  assert.equal(compile("main = select 1;").success, false);
  assert.equal(evaluate(source), 42);
});

test("strict sample demonstrates Option short-circuiting and Effect sequencing", () => {
  const output: unknown[] = [];
  const uri = new URL("../examples/strict/main.strict", import.meta.url);
  const source = readFileSync(uri, "utf8");
  assert.equal(typeof evaluate(source, (value) => output.push(value), uri.href), "function");
  assert.equal(output.length, 0);
  const result = execute(source, (value) => output.push(value), uri.href);
  assert.deepEqual(Object.keys(result as object), []);
  assert.ok(
    output.some((value) => typeof value === "string"),
    "sample prints section labels",
  );
  const values = JSON.parse(JSON.stringify(output)) as unknown[];
  assert.ok(
    values.some(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { tag?: string }).tag === "Option.Some" &&
        (value as { fields: unknown[] }).fields[0] === 42,
    ),
  );
  assert.ok(
    values.some(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        (value as { tag?: string }).tag === "Option.None",
    ),
  );
  assert.ok(output.includes(42), "effect section prints its computed answer");
});
