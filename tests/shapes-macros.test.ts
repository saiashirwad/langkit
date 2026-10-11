import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/shapes/shapes.ts";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.errors.map(error => error.message).join("\n"));
  return result.value;
};
const evaluate = (source: string, log: (value: unknown) => void = () => {}) =>
  runInNewContext(compiled(source).javascript, { console: { log } }, { timeout: 1000 });

for (const [source, expected] of [
  ["(macro twice [value] (let [result value] (+ result result))) (twice 21)", 42],
  ["(macro answer [] 42) (answer)", 42],
  ["(macro twice [x] (+ x x)) (twice (twice 10.5))", 42],
  ["(macro twice [x] (+ x x)) (macro four [x] (twice (twice x))) (four 10.5)", 42],
  ["(macro m [value] (let [result 1] (+ value result))) (let [result 41] (m result))", 42],
  ["(macro m [body] ((fn [x] body) 1)) (let [x 42] (m x))", 42],
  ["(macro m [value] (let [value value value (+ value 1)] value)) (m 41)", 42],
  ["(macro m [x] ((fn [x] x) 42)) (m 0)", 42],
  ["(macro m [x] (let [x x] ((fn [x] x) (+ x 1)))) (m 41)", 42],
  ["(def helper (fn [x] (+ x 1))) (macro m [x] (helper x)) (let [helper (fn [x] 0)] (m 41))", 42],
  ["(macro m [x] (concat x \"!\")) (let [concat (fn [a b] \"wrong\")] (m \"yes\"))", "yes!"],
  ["(def x 1) (macro m [v] (+ v x)) (let [x 41] (m x))", 42],
  ["(macro m [v] (+ v 1)) (let [m (fn [v] (+ v 2))] (m 40))", 42],
  ["(macro m [v] (+ v 1)) (macro use [m] (m 40)) (use (fn [x] (+ x 2)))", 42],
  ["(macro inner [v] (let [x 1] (+ v x))) (macro outer [v] (let [x 40] (inner (+ v x)))) (let [x 1] (outer x))", 42],
  ["(macro keep [x] x) (let [id (keep (fn [x] x)) a (id true)] (id 42))", 42],
  ["(macro selectX [x] (. {x x} x)) (selectX 42)", 42],
  ["(macro change [x] (. (update {x 0} x x) x)) (change 42)", 42],
  ["(macro selectX [x] (. (select x [x]) x)) (selectX {x 42 y true})", 42],
  ["(macro m [number] ((fn [(x number)] x) number)) (m 42)", 42],
  ["(shape S {x number}) (macro m [S] ((fn [(v S)] (. v x)) S)) (m {x 42 y true})", 42],
  ["(macro m [r] ((fn [(v {x 'a ..r})] (. v x)) r)) (m {x 42 y true})", 42],
  ["(macro activate [v] (extend v {active true})) (. (activate {x 42}) x)", 42],
  ["(macro updateAge [v] (update v age \"unknown\")) (. (updateAge {age 36 name \"Ada\"}) name)", "Ada"],
  ["(macro keep [v] v) (let [x (keep true)] (if x (keep 42) 0))", 42],
] as const) {
  test(`shapes macro evaluates: ${source}`, () => assert.equal(evaluate(source), expected));
}

for (const [source, message] of [
  ["(macro twice [x] (+ x x)) (twice \"hello\")", /Cannot unify/],
  ["(macro activate [v] (extend v {active true})) (activate {active false})", /Duplicate field/],
  ["(macro get [v] (. v missing)) (get {x 1})", /Missing field/],
  ["(macro m [x] x) (m)", /expects 1 arguments/],
  ["(macro m [] 1) (m 2)", /expects 0 arguments/],
  ["(macro m [x x] x) 1", /Duplicate macro parameter/],
  ["(macro m [if] if) 1", /Reserved binding name/],
  ["(macro if [x] x) 1", /Reserved binding name/],
  ["(macro 42 [x] x) 1", /Expected a macro name/],
  ["(macro m x x) 1", /parameters need a vector/],
  ["(macro m [x]) 1", /Expected 3 operands/],
  ["(macro m [] 1) (macro m [] 2) 1", /Duplicate macro/],
  ["(def m 1) (macro m [] 2) 1", /Duplicate macro or value/],
  ["(macro m [] unknown) 1", /Unknown definition-site identifier/],
  ["(macro m [x] (m x)) 1", /Unknown definition-site identifier/],
  ["(macro m [x] (later x)) (macro later [x] x) 1", /Unknown definition-site identifier/],
  ["(macro m [] later) (def later 42) (m)", /Unknown definition-site identifier/],
  ["(missing 42)", /Unbound variable/],
  ["(macro m [] 1) m", /Unbound variable/],
  ["(let [x 1] (macro m [] x))", /only allowed at the top level/],
  ["(macro m [] (def x 1)) 1", /only allowed at the top level/],
  ["(macro m [] (fn [x x] x)) 1", /Duplicate parameter/],
  ["(macro m [] (let [x] x)) 1", /Invalid let bindings/],
  ["(macro m [] ()) 1", /Expected an expression/],
  ["(macro m [fields] (extend {} fields)) 1", /fields cannot be spliced/],
  ["(macro m [x] ((fn [(v Unknown)] v) x)) (shape Unknown {x number}) (m {x 42})", /Unknown type/],
  ["(macro unsafe [v] (let [f v a (f 1)] (f true))) (fn [g] (unsafe g))", /Cannot unify/],
  ["(macro unsafe [v] (let [r v a (+ (. r x) 1)] (if (. r x) 1 0))) (fn [r] (unsafe r))", /Cannot unify/],
  ["(macro m [v] (let [f v] (let [a (f 1)] (f true)))) (fn [g] (m (let [h g] h)))", /Cannot unify/],
] as const) test(`shapes macro rejects: ${source}`, () => {
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.errors.some(error => message.test(error.message)));
});

test("macro expansion preserves evaluation semantics", () => {
  const log: unknown[] = [];
  evaluate("(macro twice [x] {first x second x}) (twice (print 1))", value => log.push(value));
  assert.deepEqual([...log], [1, 1]);
  log.length = 0;
  evaluate("(macro once [x] (let [result x] {first result second result})) (once (print 1))", value => log.push(value));
  assert.deepEqual([...log], [1]);
  log.length = 0;
  assert.equal(evaluate("(macro choose [condition yes no] (if condition yes no)) (choose true 42 (let [x (print 1)] 0))", value => log.push(value)), 42);
  assert.deepEqual([...log], []);
  evaluate("(macro reverse [x y] {first y second x}) (reverse (print 1) (print 2))", value => log.push(value));
  assert.deepEqual([...log], [2, 1]);
});

test("macro errors point to the outer call, not the template", () => {
  const source = '(macro add [x] (+ x 1)) (macro outer [x] (add x)) (outer "bad")';
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.errors[0]?.span?.start, source.indexOf('(outer "bad")'));
    assert.match(result.errors[0]?.context.join(" ") ?? "", /expanding macro outer.*expanding macro add/);
  }
  assert.deepEqual(analyze(source).diagnostics, result.success ? [] : result.errors);
});

test("recovered macro diagnostics retain each invocation origin and expansion context", () => {
  const source = '(macro add [x] (+ x 1)) (macro outer [x] (add x)) {first (outer "bad") second (outer false)}';
  const result = compile(source);
  assert.equal(result.success, false);
  if (!result.success) {
    const invocations = [
      '(outer "bad")',
      '(outer false)',
    ].map(text => ({ text, start: source.indexOf(text) }));
    assert.equal(result.errors.length, invocations.length);
    const matched: number[] = [];
    for (const error of result.errors) {
      const invocation = invocations.find(({ start }) => error.span?.start === start);
      assert.ok(invocation, 'every recovered error must point to one source invocation');
      matched.push(invocation.start);
      assert.equal(source.slice(error.span!.start, error.span!.end).trim(), invocation.text);
      assert.match(error.context.join(" "), /expanding macro outer.*expanding macro add/);
      assert.equal(error.origin, undefined, 'without a document URI, do not fabricate a source origin');
      assert.equal(error.location, undefined, 'without a document URI, do not fabricate a presentation location');
      for (const related of error.related ?? []) {
        assert.ok(related.location.span.start >= 0);
        assert.ok(related.location.span.end <= source.length);
        assert.ok(related.location.span.start < related.location.span.end);
        assert.ok(source.slice(related.location.span.start, related.location.span.end).length > 0);
      }
    }
    assert.deepEqual(matched.sort((a, b) => a - b), invocations.map(({ start }) => start).sort((a, b) => a - b));
    assert.deepEqual(analyze(source).diagnostics, result.errors);
  }
});

test("macro caller references retain their definition and type facts", () => {
  const source = "(macro keep [x] (let [result x] result)) (let [result 42] (keep result))";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const offset = source.lastIndexOf("result");
  assert.equal(definitionAt(analysis, offset)?.span.start, source.indexOf("result 42"));
  assert.ok(typeAt(analysis, offset));
  assert.equal(analysis.definitions.length, 2);
  assert.deepEqual(analysis.definitions.map(definition => definition.name), ["keep", "result"]);
  assert.equal(show(typeAt(analysis, source.indexOf("(keep result)"))!.type), "number");
  assert.equal(analysis.tokens.find(t => t.span.start === 1)?.kind, "keyword");
});

test("macro row inference remains polymorphic and preserves unknown fields", () => {
  const source = "(macro activate [r] (extend r {active true})) (fn [r] (activate r))";
  assert.equal(show(compiled(source).type), "({ ..r } -> { active: boolean, ..r })");
  assert.equal(evaluate("(macro activate [r] (extend r {active true})) (def f (fn [r] (activate r))) (let [a (f {x true})] (. (f {y 42}) y))"), 42);
});

test("macro definitions may be ill typed until used", () => {
  assert.equal(evaluate('(macro bad [] (+ true 1)) 42'), 42);
  assert.equal(compile('(macro bad [] (+ true 1)) (bad)').success, false);
});

test("macro expansion has deterministic depth and work bounds", () => {
  let nested = "42";
  for (let i = 0; i < 20; i++) nested = `(m ${nested})`;
  assert.equal(evaluate(`(macro m [x] x) ${nested}`), 42);
  const deep = Array.from({ length: 40 }, (_, i) => `(macro m${i} [x] ${i ? `(m${i - 1} x)` : "x"})`).join(" ");
  const result = compile(`${deep} (m39 1)`);
  assert.equal(result.success, false);
  if (!result.success) assert.ok(result.errors.some(error => /depth limit/.test(error.message)));
  const wide = Array.from({ length: 15 }, (_, i) => `(macro m${i} [x] ${i ? `(+ (m${i - 1} x) (m${i - 1} x))` : "x"})`).join(" ");
  const work = compile(`${wide} (m14 1)`);
  assert.equal(work.success, false);
  if (!work.success) assert.ok(work.errors.some(error => /resource limit/.test(error.message)));
  assert.equal(evaluate("(macro m [x] x) (m 42)"), 42);
  assert.equal(compile("(m 42)").success, false);
});


test("macro sample compiles and runs", () => {
  const source = readFileSync(new URL("../examples/shapes/macros.shapes", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(JSON.stringify(evaluate(source))), {
    originalAge: 36, updatedAge: 37, name: "Ada", language: "Shapes", active: true, twice: 42, greeting: "Hello, Ada", summary: "still exploring",
  });
});

test("macro editor metadata describes templates and concrete calls without universal types", () => {
  const source = '(macro twice [value] (+ value value)) (twice 21)';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const declaration = source.indexOf('twice');
  const call = source.lastIndexOf('twice');
  assert.equal(show(typeAt(analysis, declaration)!.type),
    '(macro twice [value]) — expression template; typechecked at use');
  assert.equal(show(typeAt(analysis, call)!.type),
    '(macro twice [value]) — expression template; typechecked at use\nExpanded result: number');
  assert.equal(show(typeAt(analysis, call - 1)!.type), 'number');
  assert.equal(definitionAt(analysis, call)!.span.start, declaration);
  assert.equal(definitionAt(analysis, declaration)!.span.start, declaration);
  assert.equal(definitionAt(analysis, declaration)!.kind, "macro");
  assert.equal(definitionAt(analysis, call)!.kind, "macro");
});

test("nested macro template references use declaration-site identity despite caller shadowing", () => {
  const source = '(macro inner [x] x) (macro outer [x] (inner x)) (let [inner (fn [x] true)] (outer (inner 42)))';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const templateCall = source.indexOf('(inner x)') + 1;
  const callerCall = source.lastIndexOf('(inner 42)') + 1;
  assert.equal(definitionAt(analysis, templateCall)!.span.start, source.indexOf('inner'));
  assert.equal(definitionAt(analysis, callerCall)!.span.start, source.indexOf('inner (fn'));
  assert.match(show(typeAt(analysis, templateCall)!.type), /expression template/);
  assert.match(show(typeAt(analysis, source.lastIndexOf('(outer') + 1)!.type), /Expanded result: boolean/);
});

test("macro parameter and template-local shadowing do not create spurious macro references", () => {
  for (const body of ['(macro outer [inner] (inner 42))', '(macro outer [f] (let [inner f] (inner 42)))']) {
    const source = `(macro inner [x] x) ${body} (outer (fn [x] x))`;
    const analysis = analyze(source);
    assert.deepEqual(analysis.diagnostics, []);
    assert.equal(definitionAt(analysis, source.indexOf('(inner 42)') + 1), undefined);
  }
});

test("macro reference facts do not leak generated call spans and respect declaration order", () => {
  const source = '(macro first [x] x) (macro second [x] (first x)) (second (first 42))';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  for (const reference of analysis.references) {
    const definition = analysis.definitions.find(value => value.id === reference.id)!;
    assert.equal(source.slice(reference.span.start, reference.span.end), definition.name);
  }
  assert.equal(analysis.references.length, 3);
  const invalid = analyze('(macro second [x] (first x)) (macro first [x] x) (second 1)');
  assert.equal(invalid.diagnostics.length, 1);
  assert.equal(invalid.references.length, 0);
});
