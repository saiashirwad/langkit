import assert from "node:assert/strict";
import { test } from "node:test";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/shapes/shapes.ts";

const customer = '(shape Customer {name string email string}) ';
const display = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  return show(result.value.type);
};

test("named annotations abbreviate fixed fields, not structurally matching inferred records", () => {
  assert.equal(display(customer + '(fn [(c Customer)] (. c name))'), '(Customer -> string)');
  assert.equal(display(customer + '(fn [c] (. c name))'), '({ name: a, ..r } -> a)');
  assert.equal(display(customer + '{name "Ada" email "a"}'), '{ email: string, name: string }');
});

test("strengthened named annotations expose every added requirement", () => {
  assert.equal(display(customer + '(fn [(c Customer)] (if (. c member) (. c name) ""))'),
    '(Customer & { member: boolean } -> string)');
});

test("named identity and record updates preserve visible row relationships", () => {
  assert.equal(display(customer + '(fn [(c Customer)] c)'),
    '(Customer & { ..r } -> Customer & { ..r })');
  const changed = display(customer + '(fn [(c Customer)] (update c email 0))');
  assert.match(changed, /Customer & \{ \.\.r \}/);
  assert.match(changed, /email: number/);
  assert.equal(changed.match(/\.\.r/g)?.length, 2);
});

test("specialized and variable-bearing shapes expand instead of concealing their fields", () => {
  assert.equal(display("(shape Box {value 'a}) (fn [(box Box)] (+ (. box value) 1))"),
    '({ value: number, ..r } -> number)');
  assert.equal(display("(shape Pair {left 'a right 'a}) (fn [(p Pair)] (. p left))"),
    '({ left: a, right: a, ..r } -> a)');
});

test("closed instantiations expand, with independent field sets on generalized uses", () => {
  const source = customer + '(def identity (fn [(c Customer)] c)) ' +
    '{first (identity {name "Ada" email "a" age 36}) second (identity {name "Grace" email "g" member true})}';
  const result = display(source);
  assert.match(result, /age: number/);
  assert.match(result, /member: boolean/);
  assert.doesNotMatch(result, /Customer/);
  const analysis = analyze(source);
  assert.match(show(typeAt(analysis, source.indexOf('identity'))!.type), /Customer & \{ \.\.r \}/);
});

test("shape annotation hovers and definitions have exact source-name spans", () => {
  const source = customer + '(def greet (fn [(c Customer)] (. c name))) greet';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  for (const at of [source.indexOf('Customer'), source.lastIndexOf('Customer')]) {
    assert.equal(show(typeAt(analysis, at)!.type), 'shape Customer = { email: string, name: string, ..r }');
    const definition = definitionAt(analysis, at)!;
    assert.equal(definition.kind, "type");
    assert.equal(definition.name, 'Customer');
    assert.deepEqual(definition.span, { start: 7, end: 15 });
  }
  assert.equal(show(typeAt(analysis, source.indexOf('greet'))!.type), '(Customer -> string)');
});

test("nested annotation references and higher-order types retain named provenance", () => {
  const source = customer + '(fn [(callback (-> Customer string)) (c Customer)] (callback c))';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  for (const match of source.matchAll(/Customer/g)) {
    assert.equal(definitionAt(analysis, match.index)?.span.start, 7);
  }
  const result = display(source);
  assert.match(result, /Customer & \{ \.\.r \}/);
  assert.equal(result.match(/\.\.r/g)?.length, 2);
});

test("nested named shapes stay visible without hiding their independently open fields", () => {
  const source = '(shape Inner {name string}) (shape Outer {child Inner}) (fn [(o Outer)] (. (. o child) name))';
  assert.equal(display(source), '({ child: Inner, ..r1 } -> string)');
  const analysis = analyze(source);
  assert.equal(definitionAt(analysis, source.indexOf('Inner}'))?.name, 'Inner');
  assert.match(show(typeAt(analysis, source.lastIndexOf('Outer'))!.type), /child: Inner/);
});

test("shape and value names inhabit separate namespaces", () => {
  const source = '(shape Customer {name string}) (def Customer 4) (fn [(c Customer)] (+ Customer 1))';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(definitionAt(analysis, source.lastIndexOf('Customer)]'))?.span.start, 7);
  assert.equal(definitionAt(analysis, source.lastIndexOf('Customer 1'))?.span.start, source.indexOf('Customer 4'));
});

test("macro template type references point to definition-site shapes even when parameters share their names", () => {
  const source = '(shape Customer {name string}) (macro nameOf [Customer] ((fn [(c Customer)] (. c name)) Customer)) (nameOf {name "Ada"})';
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const offset = source.indexOf('Customer)]');
  assert.equal(definitionAt(analysis, offset)?.span.start, 7);
  assert.equal(show(typeAt(analysis, offset)!.type), 'shape Customer = { name: string, ..r }');
  assert.equal(display(source), 'string');
});

test("unused templates do not start typechecking because their annotations are observed", () => {
  assert.equal(display('(macro bad [] (fn [(x Unknown)] x)) 1'), 'number');
});

test("names preserve extra absence constraints without exposing implied ones", async () => {
  const { freshRow, named, number, record, row, show: showType } = await import('../examples/shapes/shapes-types.ts');
  const tail = freshRow(['age', 'active']);
  const value = named(record(row(new Map([['age', number]]), tail)), 'Person');
  assert.equal(showType(value), 'Person & { ..r } where r lacks active');
  assert.deepEqual([...tail.lacks], ['age', 'active']);
});


