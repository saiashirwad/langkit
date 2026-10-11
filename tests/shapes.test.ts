import assert from "node:assert/strict";
import { pure, run } from "langkit";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { typeAt, definitionAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/shapes/shapes.ts";
import { fresh, fn, number, string, unify } from "../examples/shapes/shapes-types.ts";
import { template } from "../examples/shapes/shapes-macros.ts";
import type { Form } from "../examples/shapes/shapes-syntax.ts";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.errors.map(({ message }) => message).join("\n"));
  return result.value;
};
const evaluate = (source: string, log: (value: unknown) => void = () => {}) =>
  runInNewContext(compiled(source).javascript, { console: { log } }, { timeout: 1000 });


for (const [source, message] of [
  ["(. {y 1} x)", /Missing field/],
  ["(+ true 1)", /Cannot unify/],
  ["(concat \"x\" 1)", /Cannot unify/],
  ["(if 1 true false)", /Cannot unify/],
  ["(if true {x 1} {y 2})", /Missing field/],
  ["{x 1 x 2}", /Duplicate field/],
  ["(extend {x 1} {x 2})", /Duplicate field/],
  ["(def add (fn [r] (extend r {x true}))) (add {x 1})", /Duplicate field/],
  ["(def add (fn [r] (extend r {x true}))) (def alias add) (alias {x 1})", /Duplicate field/],
  ["(merge {x 1} {x 2})", /Duplicate field/],
  ["(fn [a b] (merge a b))", /statically closed/],
  ["(update {} x 1)", /Missing field/],
  ["(select {x 1} [y])", /Missing field/],
  ["(select {x 1} [x x])", /Duplicate field/],
  ["(select 1 [])", /Cannot unify/],
  ["(fn [x] (x x))", /Infinite type/],
  ["(fn [r] ((. r x) r))", /Infinite type|Infinite row/],
  ["(fn [r] (let [alias r added (extend alias {x 1})] (. r x)))", /Duplicate field/],
  ["(fn [r] (let [get (fn [ignored] (. r x)) a (+ (get 1) 1)] (if (get true) 1 0)))", /Cannot unify/],
  ["(fn [f] (let [a (f {x 1})] (f {x true})))", /Cannot unify/],
  ["(fn [r] (if true (extend r {x 1}) (extend r {y 1})))", /Infinite row/],
  ["((fn [r s] (. (if false (extend s {x r y 1}) (extend r {x (extend s {y true})})) y)) {y true} {})", /Cannot unify/],
  ["((fn [r s] ((. (if false (extend s {x r y (fn [z] z)}) (extend r {x (extend s {y true})})) y) 42)) {y true} {})", /Cannot unify/],
  ["(fn [r] (if true r (extend r {x 1})))", /Infinite row/],
  ["(fn [r] (if true r (. r x)))", /Infinite/],
  ["(shape Named {name string}) ((fn [(x Named)] x) {name 1})", /Cannot unify/],
  ["(shape Named {name string}) ((fn [(x Named)] x) {age 1})", /Missing field/],
  ["((fn [(r {x number})] r) {x 1 y 2})", /Missing field/],
  ["(fn [(r {x number ..r})] (extend r {x 1}))", /Duplicate field/],
  ["(fn [(x number)] (concat x \"x\"))", /Cannot unify/],
  ["(fn [(x Unknown)] x)", /Unknown type/],
  ["(fn [(a {x number ..r}) (b {y string ..r})] (if true a b))", /Infinite row|Duplicate field/],
  ["(let [f (fn [x] (let [g (fn [y] (x y)) a (g 1)] (g true)))] f)", /Cannot unify/],
  ["(shape Bad {x Missing}) 1", /Unknown type/],
  ["(shape A {x number}) (shape A {y number}) 1", /Duplicate shape/],
  ["(def x 1) (def x 2) x", /Duplicate definition/],
  ["(fn [x x] x)", /Duplicate parameter/],
  ["(fn [true] true)", /Reserved binding name/],
  ["(def if 1) if", /Reserved binding name/],
  ["(let [false 1] false)", /Reserved binding name/],
  ["(fn [] 1)", /nonempty parameter/],
  ["(fn [(x)] x)", /Annotated parameter/],
  ["(fn [(r {x number ..})] r)", /row tail/],
  ["(fn [(r {..r x number})] r)", /row tail/],
  ["(fn [(r {x number x string})] r)", /Duplicate field/],
  ["(fn [(r {x})] r)", /Missing type/],
  ["{x}", /name\/value/],
  ["(if true 1)", /operands/],
  ["(let [x] x)", /let syntax/],
  ["(let [x 1] (def y 2))", /top level/],
  ["1 2", /final top-level/],
  ["(def x 1)", /end with an expression/],
  ["", /end with an expression/],
  ["1e999", /too large/],
  ["(fn [x] x", /.+/],
  ['"bad\\q"', /.+/],
] as const) test(`shapes rejects: ${source}`, () => {
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.errors[0].message, message);
});
test("Shapes parser errors retain their message and parsing context", () => {
  for (const source of ["(fn [x] x", '"bad\\q"']) {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.ok(result.errors[0].message.length > 0);
      assert.equal(result.errors[0].context[0], "parsing");
    }
  }
});

test("shapes immutable transformations evaluate arguments once, left to right", () => {
  for (const op of ["update", "extend", "merge", "select"]) {
    const log: unknown[] = [];
    const base = '(let [ignored (print 1)] {x 10})';
    const value = '(let [ignored (print 2)] 42)';
    const expression = op === "update" ? `(update ${base} x ${value})`
      : op === "select" ? `(select ${base} [x])`
      : `(${op} ${base} {y ${value}})`;
    evaluate(expression, (value) => log.push(value));
    assert.deepEqual(log, op === "select" ? [1] : [1, 2]);
  }
  const log: unknown[] = [];
  assert.equal(evaluate('(if true 42 (let [ignored (print 1)] 0))', (x) => log.push(x)), 42);
  assert.deepEqual(log, []);
});
test("shapes analysis locates parameter references and diagnostics", () => {
  const source = '(def get (fn [r] (. r x))) (get {x 42})';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const reference = source.indexOf("r x");
  assert.equal(definitionAt(analysis, reference)?.span.start, source.indexOf("r]"));
  assert.ok(typeAt(analysis, source.lastIndexOf("42")));
  const bad = analyze('(+ true 1)');
  assert.equal(bad.diagnostics.length, 1);
  assert.ok(bad.diagnostics[0]?.span);
  assert.equal(analyze('(').diagnostics.length, 1);
});

test("shapes compilation and analysis do not leak inference state", () => {
  const source = '(fn [r] (extend r {flag true}))';
  const first = show(compiled(source).type);
  compile('(fn [x] (x x))');
  analyze('(fn [r] (. r x))');
  assert.equal(show(compiled(source).type), first);
});

test("shapes sample and CLI run", () => {
  const sample = new URL('../examples/shapes/main.shapes', import.meta.url);
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(readFileSync(sample, 'utf8')))), {
    greeting: 'Hello, Ada', age: 37, language: 'Shapes', active: true, count: 42,
  });
  const result = spawnSync(process.execPath, ['examples/shapes/shapes.ts'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hello, Ada/);
});

test("Shapes inference allocations are isolated per Check run and constraints roll back", () => {
  const allocation = fresh();
  const first = run(allocation);
  const second = run(allocation);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value, second.value);

  const partial = run(unify(fn(first.value, number), fn(number, string)));
  assert.equal(partial.success, false);
  assert.equal(show(first.value), "a");
});

test("Shapes collects independent type diagnostics without emitting a program", () => {
  const source = "(+ true false)";
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.every(({ message }) => /Cannot unify/.test(message)));
    assert.deepEqual(result.errors.map(({ span }) => span?.start), [source.indexOf("true"), source.indexOf("false")]);
  }
  assert.equal(analyze(source).diagnostics.length, 2);
});
test("Shapes template visit budgets reset when a Check is reused", () => {
  const span = { start: 0, end: 1 };
  const items: Form[] = [{ kind: "symbol", value: "f", span }];
  for (let index = 0; index < 6000; index++)
    items.push({ kind: "symbol", value: `arg${index}`, span });
  const root: Form = { kind: "list", items, span };
  const visit = template(root, (reference) => pure(reference));
  const first = run(visit);
  const second = run(visit);
  assert.ok(first.success && second.success);
  if (!first.success || !second.success) return;
  if (first.value.kind !== "list" || second.value.kind !== "list")
    throw new Error("Template visit changed the root form kind");
  assert.equal(first.value.items.length, items.length);
  assert.equal(second.value.items.length, items.length);
});
