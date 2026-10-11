import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { typeAt, definitionAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/shapes/shapes.ts";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  return result.value;
};
const evaluate = (source: string, log: (value: unknown) => void = () => {}) =>
  runInNewContext(compiled(source).javascript, { console: { log } }, { timeout: 1000 });

for (const [source, expected] of [
  ["(fn [r] (. r x))", "({ x: a, ..r } -> a)"],
  ["(fn [r] (extend r {flag true}))", "({ ..r } -> { flag: boolean, ..r })"],
  ["(fn [r] (+ (. r x) (. r y)))", "({ x: number, y: number, ..r } -> number)"],
  ["(fn [r] (update r x true))", "({ x: a, ..r } -> { x: boolean, ..r })"],
  ["(fn [r] (select r [x]))", "({ x: a, ..r } -> { x: a })"],
  ["(fn [(r {x 'a ..rest})] (. r x))", "({ x: a, ..r } -> a)"],
  ["(fn [f g x] (f (g x)))", "((a -> b) -> ((c -> a) -> (c -> b)))"],
  ["{}", "{}"],
  ["print", "(a -> {})"],
] as const) test(`shapes inferred type: ${source}`, () => assert.equal(show(compiled(source).type), expected));

for (const [source, expected] of [
  ["(+ 20 22)", 42],
  ["; comment\n(let [id (fn [x] x) ignored (id true)] (id 42)) ; eof", 42],
  ["(def get (fn [r] (. r x))) (let [a (get {x true})] (if a (get {y false x 42}) 0))", 42],
  ["(def add (fn [r] (extend r {flag true}))) (let [a (add {x 1})] (. (add {y 42}) y))", 42],
  ["(def add (fn [r] (extend r {flag true}))) (def alias add) (. (alias {x 42}) x)", 42],
  ["(shape Named {name string}) (def greet (fn [(p Named)] (concat \"Hello, \" (. p name)))) (greet {name \"Ada\" age 36})", "Hello, Ada"],
  ["(def birthday (fn [(p {age number ..r})] (update p age (+ (. p age) 1)))) (. (birthday {name \"Ada\" age 36}) name)", "Ada"],
  ["(def birthday (fn [(p {age number ..r})] (update p age (+ (. p age) 1)))) (. (birthday {name \"Ada\" age 36}) age)", 37],
  ["(let [original {x 42 y true} changed (update original x \"new\")] (. original x))", 42],
  ["(. (update {x 42 y true} x \"new\") x)", "new"],
  ["(. (update {x 42 y true} x \"new\") y)", true],
  ["(. (merge {x 42} {y true}) x)", 42],
  ["((fn [r s] (. (if false (extend s {x r y false}) (extend r {x (extend s {y true})})) y)) {y true} {})", true],
  ["((fn [r s] (. (if true (extend r {x (extend s {y true})}) (extend s {x r y false})) y)) {y true} {})", true],
  ["(def add (fn [r] (merge r {flag true}))) (. (add {x 42}) x)", 42],
  ["(. (select {x 42 y true z \"hi\"} [y x]) x)", 42],
  ["(. {nested {x 42}} nested)", { x: 42 }],
  ["(. {__proto__ 42 constructor 1} __proto__)", 42],
  ["(. (update {__proto__ 1} __proto__ 42) __proto__)", 42],
  ["(. (extend {} {__proto__ 42}) __proto__)", 42],
  ["(. (merge {} {__proto__ 42}) __proto__)", 42],
  ["(. (select {__proto__ 42} [__proto__]) __proto__)", 42],
  ["(let [x 1 f (fn [y] (+ x y)) x 100] (f 41))", 42],
  ["(def apply (fn [(f (-> number number)) x] (f x))) (apply (fn [n] (+ n 1)) 41)", 42],
  ["(def same (fn [(a {x number ..r}) (b {y string ..r})] (. b z))) (same {x 0 z 42} {y \"yes\" z 42})", 42],
  ["(shape Inner {x number}) (shape Outer {child Inner}) ((fn [(p Outer)] (. (. p child) x)) {child {x 42 extra true} other false})", 42],
  ["(def keep (fn [(p {x 'a ..r})] p)) (let [a (keep {x true y 1})] (. (keep {x 42 z false}) x))", 42],
  ["(let [f (fn [r] (fn [x] (extend r {value x})))] (. ((f {answer 42}) true) answer))", 42],
] as const) test(`shapes evaluates: ${source}`, () => {
  // VM records have a different prototype; compare their serialized data.
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(source))), expected);
});

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
  if (!result.success) assert.match(result.error.message, message);
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
