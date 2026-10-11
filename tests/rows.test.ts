import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { choice, run } from "langkit";
import { typeAt, definitionAt } from "langkit/analysis";
import {
  analyze,
  compile as compileSource,
  elaborateBody,
  program,
  show,
} from "../examples/rows/rows.ts";

const compile = (source: string) =>
  compileSource('import "./stdlib.rows";\n' + source, {
    uri: new URL("../examples/rows/test.rows", import.meta.url).href,
  });

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n"));
  return result.value;
};

const evaluate = (source: string, log: (value: unknown) => void = () => {}) =>
  runInNewContext(compiled(source).javascript, { console: { log } }, { timeout: 1000 });

for (const [source, expected] of [
  ["fn(r) => r.x", "({ x: a | r } -> a) where r lacks x"],
  ["fn(r) => { flag = true | r }", "({ | r } -> { flag: boolean | r }) where r lacks flag"],
  ["fn(r) => r.x + r.y", "({ x: number, y: number | r } -> number) where r lacks x, y"],
  ["fn(r) => { copy = r.x | r }", "({ x: a | r } -> { copy: a, x: a | r }) where r lacks copy, x"],
  [
    "fn(r) => if true then { x = 1 | r } else { x = 2 | r }",
    "({ | r } -> { x: number | r }) where r lacks x",
  ],
  ["{}", "{}"],
  ['"hello"', "string"],
  ["compose", "((a -> b) -> ((c -> a) -> (c -> b)))"],
  ["print", "(a -> {})"],
] as const) {
  test(`rows principal type: ${source}`, () => assert.equal(show(compiled(source).type), expected));
}

for (const [source, expected] of [
  [
    "let getX = fn(r) => r.x in let a = getX({ x = true }) in if a then getX({ y = false, x = 42 }) else 0",
    42,
  ],
  ["let add = fn(r) => { flag = true | r } in let a = add({ x = 1 }) in add({ y = 42 }).y", 42],
  ["let add = fn(r) => { flag = true | r } in let alias = add in alias({ x = 42 }).x", 42],
  ["(if true then { x = 42, y = true } else { y = false, x = 1 }).x", 42],
  ["{ nested = { x = 42 } }.nested.x", 42],
  ["{ f = fn(x) => { answer = x } }.f(42).answer", 42],
  ["let get = fn(r) => r.x in compose(get)(fn(r) => { x = 42 | r })({ y = true })", 42],
  ["let get = fn(r) => r.x in let b = get({ x = true }) in get({ x = fn(x) => x })(42)", 42],
  ["let ignored = id(true) in const(42)(id({ x = 1 }))", 42],
  ["{ __proto__ = 42, constructor = 1 }.__proto__", 42],
  ['"hello\\nworld"', "hello\nworld"],
  ["let print = fn(x) => x in print(42)", 42],
  [
    "(fn(r) => fn(s) => (if false then { x = r, y = false | s } else { x = { y = true | s } | r }).y)({ y = true })({})",
    true,
  ],
  [
    "(fn(r) => fn(s) => (if true then { x = { y = true | s } | r } else { x = r, y = false | s }).y)({ y = true })({})",
    true,
  ],
] as const) {
  test(`rows execution: ${source}`, () => assert.equal(evaluate(source), expected));
}

for (const [source, error] of [
  ["{}.x", /Missing field/],
  ["{ y = true }.x", /Missing field/],
  ["{ x = 1, x = true }", /Duplicate field/],
  ["{ x = 1 | { x = true } }", /Duplicate field/],
  ["let add = fn(r) => { x = 1 | r } in add({ x = false })", /Duplicate field/],
  [
    "let add = fn(r) => { x = 1 | r } in let alias = add in alias({ x = false })",
    /Duplicate field/,
  ],
  ["fn(r) => let alias = r in let a = { x = 1 | alias } in r.x", /Duplicate field/],
  [
    "fn(r) => let get = fn(ignored) => r.x in let a = get(1) + 1 in if get(true) then 1 else 0",
    /Cannot unify/,
  ],
  ["fn(f) => let a = f({ x = 1 }) in f({ x = true })", /Cannot unify/],
  ["fn(r) => if true then r else { x = 1 | r }", /Infinite row/],
  ["fn(r) => if true then r else r.x", /Infinite type/],
  ["fn(r) => r.x(r)", /Infinite type|Infinite row/],
  ["fn(r) => if true then { x = 1 | r } else { y = 1 | r }", /Infinite row/],
  ["if true then { x = 1 } else { x = true }", /Cannot unify/],
  // Unifying x exposes y through a solved tail; that newly shared field must also unify.
  [
    "(fn(r) => fn(s) => (if false then { x = r, y = 1 | s } else { x = { y = true | s } | r }).y)({ y = true })({})",
    /Cannot unify/,
  ],
  [
    "(fn(r) => fn(s) => (if false then { x = r, y = fn(z) => z | s } else { x = { y = true | s } | r }).y(42))({ y = true })({})",
    /Cannot unify/,
  ],
  ["{ x = 1 | 42 }", /Cannot unify/],
  ["1.x", /Cannot unify/],
] as const) {
  test(`rows rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.errors.map((item) => item.message).join("\n"), error);
  });
}

for (const source of [
  '"unterminated',
  '"bad\\q"',
  '"raw\tcontrol"',
  '"raw\u0000control"',
  "{ x = }",
  "{ x = 1 | }",
  "{}. ",
  "{ x = 1, }",
]) {
  test(`rows malformed syntax: ${source}`, () => assert.equal(compile(source).success, false));
}

test("rows print is polymorphic, ordered, and returns the empty record", () => {
  const output: unknown[] = [];
  const result = evaluate(
    'let a = print("hello") in let b = print(42) in let c = print(true) in print({ x = 1 })',
    (x) => output.push(x),
  );
  assert.deepEqual(output.slice(0, 3), ["hello", 42, true]);
  assert.equal((output[3] as { x: number }).x, 1);
  assert.deepEqual(Object.keys(result), []);
});

test("rows effect order follows fields before the extension base, once each", () => {
  const output: unknown[] = [];
  evaluate("{ x = print(1), y = print(2) | (let ignored = print(3) in {}) }", (x) =>
    output.push(x),
  );
  assert.deepEqual(output, [1, 2, 3]);
});

test("rows sample evaluates to 42 and prints its answer", () => {
  const output: unknown[] = [];
  const source = readFileSync(new URL("../examples/rows/main.rows", import.meta.url), "utf8");
  assert.equal(
    evaluate(source, (x) => output.push(x)),
    42,
  );
  assert.deepEqual(output, ["The answer is:", 42]);
});

test("rows analysis keeps library spans out of user facts and never prints", () => {
  const source = "let get = fn(r) => r.x in get({ x = 42, flag = true })";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(analysis.definitions.length, 2);
  assert.equal(
    show(typeAt(analysis, source.lastIndexOf("get"))!.type),
    "({ flag: boolean, x: number } -> number)",
  );
  assert.equal(definitionAt(analysis, source.lastIndexOf("get"))?.span.start, 4);
  assert.deepEqual(analyze('print("hello")').diagnostics, []);
  assert.deepEqual(
    analyze('"let fake = 1"').tokens.map((token) => token.kind),
    ["string"],
  );
});

test("rows reusable checking allocates fresh ordinary and row variables", () => {
  const parsed = program.parse("fn(r) => r.x");
  assert.ok(parsed.success);
  const computation = elaborateBody(parsed.value);
  const first = run(computation);
  const second = run(computation);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value.result.type, second.value.result.type);
  assert.equal(show(first.value.result.type), show(second.value.result.type));
  const before = analyze("fn(r) => r.x");
  compile("fn(r) => if true then r else { x = 1 | r }");
  assert.equal(show(typeAt(before, 3)!.type), "{ x: a | r } where r lacks x");
});

test("rows rolls back an abandoned elaboration and its diagnostics", () => {
  const rejected = program.parse('let hidden = true + "x" in hidden');
  const fallback = program.parse("42");
  assert.ok(rejected.success && fallback.success);
  const selected = run(choice(elaborateBody(rejected.value), elaborateBody(fallback.value)));
  assert.ok(selected.success);
  assert.equal(selected.value.declarations.length, 0);
  assert.equal(show(selected.value.result.type), "number");
});

test("rows reports independent binary operand errors together", () => {
  const result = compile('true + "x"');
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.every((error) => /Cannot unify/.test(error.message)));
  }
});
