import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { validate } from "langkit/ir";
import { analyze, compile, show } from "../examples/ur/ur.ts";

const merge = `fn merge<A: Row<Type>, B: Row<Type>>(left: Record<A>, right: Record<B>)
  -> Record<A ++ B> where disjoint(A, B) = left ++ right;`;
const identity = "fn identity<A>(value: A) -> A = value;";
const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  validate(result.value.ir); return result.value;
};
const evaluate = (source: string): unknown => runInNewContext(compiled(source).javascript, {}, { timeout: 1000 });

for (const [source, expected] of [
  ["let main = 12 - 3 - 2;", 7],
  ["let main = 2 + 3 * 4;", 14],
  ["let main = -2 * 3;", -6],
  ["let main = if 4 > 2 then 42 else 0;", 42],
  ["let main = if \"a\" == \"a\" then 42 else 0;", 42],
  ["let main = if true == false then 0 else 42;", 42],
  [`${identity} let main = if identity(true) then identity(42) else 0;`, 42],
  [`${identity} let alias = identity; let main = alias(42);`, 42],
  [`${identity} let main = identity({ answer: 42 }).answer;`, 42],
  ["fn id<A: Type>(value: A) -> A = value; let main = id(42);", 42],
  ["fn greet(person: { name: string }) -> string = person.name; let main = greet({ name: \"Ada\" });", "Ada"],
  [`${merge} let main = merge({ name: "Ada" }, { age: 37 }).age;`, 37],
  [`${merge} let main = merge({}, { answer: 42 }).answer;`, 42],
  [`${merge} let main = merge({ answer: 42 }, {}).answer;`, 42],
  ["let main = ({ a: 20 } ++ { b: 22 }).a + ({ a: 20 } ++ { b: 22 }).b;", 42],
  ["let main = ({ a: 20 }++{ b: 22 }).b;", 22],
  ["fn id<R: Row<Type>>(value: Record<R>) -> Record<R> = value; let main = id({ x: 42 }).x;", 42],
  ["fn get<R: Row<Type>>(value: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = value.x; let main = get({ y: true, x: 42 });", 42],
  [`${merge} fn extend<R: Row<Type>>(value: Record<R>) -> Record<R ++ { x: number }> where disjoint(R, { x: number }) = merge(value, { x: 42 }); let main = extend({ y: true }).x;`, 42],
  [`${merge} fn swap<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> Record<B ++ A> where disjoint(A, B) = merge(b, a); let main = swap({ x: 42 }, { y: false }).x;`, 42],
  [`${merge} fn three<A: Row<Type>, B: Row<Type>, C: Row<Type>>(a: Record<A>, b: Record<B>, c: Record<C>) -> Record<A ++ B ++ C> where disjoint(A, B), disjoint(A ++ B, C) = merge(merge(a, b), c); let main = three({ x: 1 }, { y: 42 }, { z: 3 }).y;`, 42],
  ["fn makeAdder(amount: number) -> number -> number = fn(value: number) => value + amount; let plus20 = makeAdder(20); let main = plus20(22);", 42],
  ["let x = 20; fn add(y: number) -> number = x + y; let main = let x = 100 in add(22);", 42],
  ["let x = 20; let main = (fn(x: number) => fn(y: number) => x + y)(40)(2);", 42],
  ["fn answer() -> number = 42; let main = answer();", 42],
  ["fn add(a: number, b: number) -> number = a + b; let main = add(20, 22);", 42],
  ["fn apply(f: number -> number, x: number) -> number = f(x); let main = apply(fn(n: number) => n + 1, 41);", 42],
  ["let main: { a: number, b: boolean } = { b: true, a: 42 }; let answer = main.a;", undefined],
  ["fn same<A>(x: A, y: A) -> A = x; let main = same({ x: 42, y: true }, { y: false, x: 1 }).x;", 42],
  ["let main = { __proto__: 42 }.__proto__;", 42],
  [`${merge} let main = merge({ __proto__: 42 }, { constructor: true }).__proto__;`, 42],
] as const) {
  test(`Ur execution: ${source}`, () => {
    const result = evaluate(source);
    if (expected !== undefined) assert.equal(result, expected);
    else assert.equal((result as { a: number }).a, 42);
  });
}

for (const [source, message] of [
  ["let main = unknown;", /Unknown value/],
  ["let main: number = true;", /Expected number/],
  ["let main = 1(true);", /Expected a function/],
  ["let main = 1 + true;", /Expected number/],
  ["let main = true > false;", /Expected number/],
  ["let main = 1 == true;", /Expected number/],
  ["let main = {} == {};", /Equality.*primitive/],
  ["let main = if 1 then 2 else 3;", /Expected boolean/],
  ["let main = if true then 2 else false;", /Expected number/],
  ["let main = { x: 1, x: 2 };", /Duplicate field/],
  ["let main: { x: number, x: boolean } = { x: 1 };", /Duplicate field/],
  ["let main = { x: 1 }.y;", /Unknown field/],
  ["let main = 1.x;", /Expected a record/],
  ["let x = 1; let x = 2; let main = x;", /Duplicate declaration/],
  ["fn x(a: number) -> number = a; let x = 1; let main = x;", /Duplicate declaration/],
  ["fn f(a: number, a: number) -> number = a; let main = 0;", /Duplicate parameter/],
  ["fn f<A, A>(a: A) -> A = a; let main = 0;", /Duplicate.*type parameter/],
  ["fn f<number>(a: number) -> number = a; let main = 0;", /reserved type parameter/],
  ["fn f(a: Missing) -> number = 1; let main = 0;", /Unknown type/],
  ["fn bad<A>(x: A) -> A = 1; let main = 0;", /Expected A/],
  ["fn bad<A>(x: A) -> number = x; let main = 0;", /Expected number/],
  ["fn bad<A>(x: A) -> number = x + 1; let main = 0;", /Expected number/],
  ["fn bad<A, B>(x: A) -> B = x; let main = 0;", /Expected B/],
  [`${identity} fn bad<A>(x: A) -> number = identity(x); let main = 0;`, /Expected number/],
  ["fn same<A>(x: A, y: A) -> A = x; let main = same(1, true);", /Expected number/],
  ["fn f(x: number) -> boolean = x; let main = 0;", /Expected boolean/],
  ["fn f(x: number) -> number = x; let main = f();", /Expected 1 arguments/],
  ["fn f(x: number) -> number = x; let main = f(1, 2);", /Expected 1 arguments/],
  ["fn f(a: number, b: number) -> number = a; let main = f(1);", /Expected 2 arguments/],
  ["let main = (fn(x: number) => x)(true);", /Expected number/],
  ["fn bad<R: Row<Type>>(x: R) -> number = 0; let main = 0;", /Expected Type.*Row/],
  ["fn bad<A>(x: Record<A>) -> number = 0; let main = 0;", /Expected Row.*Type/],
  ["fn bad<R: Row<Type>>(x: Record<R>) -> number = x.answer; let main = 0;", /Unknown field/],
  ["let main = { x: 1 } ++ { x: 2 };", /Overlapping field/],
  ["let main = {} ++ 1;", /requires two records/],
  [`${merge} let main = merge({ x: 1 }, { x: true });`, /Overlapping field/],
  [`${merge} let alias = merge; let main = alias({ x: 1 }, { x: 2 });`, /Overlapping field/],
  ["fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> Record<A ++ B> = a ++ b; let main = 0;", /Cannot prove disjoint/],
  ["fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = a ++ b in {}; let main = 0;", /Cannot prove disjoint/],
  [`${merge} fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = merge(a, b) in {}; let main = 0;`, /Cannot prove disjoint/],
  ["fn bad<A: Row<Type>>(a: Record<A>) -> {} = let unused = a ++ a in {}; let main = 0;", /row with itself/],
  ["fn bad<A: Row<Type>>(a: Record<A>) -> Record<A> where disjoint(A, A) = a; let main = 0;", /row with itself/],
  ["fn bad(x: number) -> number where disjoint({ x: number }, { x: boolean }) = x; let main = 0;", /Overlapping field/],
  ["fn bad<A>(a: A) -> A where disjoint(A, {}) = a; let main = 0;", /Expected Row/],
  ["fn bad<R: Row<Type>>(a: Record<R>) -> Record<R> where disjoint(R, { x: number }) = a; let main = bad({ x: 1 });", /Overlapping field/],
  ["fn bad<R: Row<Type>>(a: Record<R>) -> Record<R> where disjoint(R, { x: number }) = a; let main = bad({ x: true });", /Overlapping field/],
  ["fn f<A: Row<Type>, B: Row<Type>>(x: Record<A ++ B>) -> Record<A ++ B> where disjoint(A, B) = x; let main = f({ x: 1 });", /Ambiguous row decomposition/],
  ["fn f<R: Row<Type>>(x: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = x.x; let main = f({ x: true });", /Expected number/],
  ["fn f<R: Row<Type>>(x: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = x.x; let main = f({ y: 1 });", /Missing field/],
  ["fn f<R: Row<Type>>(x: Record<R>, y: Record<R>) -> Record<R> = x; let main = f({ x: 1 }, { x: 1, y: 2 });", /rows do not match/],
  ["fn f(x: { x: number }) -> number = x.x; let main = f({ x: 1, y: 2 });", /rows do not match/],
  [`${identity} fn apply(f: number -> number) -> number = f(42); let main = apply(identity);`, /monomorphic function/],
  [`${identity} let main = identity(identity);`, /Polymorphic values/],
  ["fn f(x: number) -> number = g(x); fn g(x: number) -> number = x; let main = 0;", /Unknown value: g/],
  ["let x = let inner = 42 in inner; let main = inner;", /Unknown value/],
  ["fn f(x: number) -> number = x; let main = x;", /Unknown value/],
  ["let x = 42;", /Missing entry/],
  ["type Option<A> = None | Some(A); let main = 0;", /./],
] as const) {
  test(`Ur rejects: ${source}`, () => {
    const result = compile(source); assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  });
}

test("Ur's example is runnable and returns null-prototype concatenated records", () => {
  const source = readFileSync(new URL("../examples/ur/main.ur", import.meta.url), "utf8");
  const result = evaluate(source) as { person: { name: string; age: number; active: boolean }; answer: number };
  assert.equal(result.answer, 42); assert.equal(result.person.name, "Ada"); assert.equal(result.person.age, 37);
  assert.equal(result.person.active, true); assert.equal(Object.getPrototypeOf(result.person), null);
});

test("Ur analysis reports call types, lexical definitions, and partial facts", () => {
  const source = `${identity} let value = 42; let main = let value = true in identity(value);`;
  const analysis = analyze(source); assert.deepEqual(analysis.diagnostics, []);
  // The identifier carries the generic function type; the call's opening
  // parenthesis belongs to the call expression, whose result is boolean.
  assert.equal(show(typeAt(analysis, source.lastIndexOf("identity(value)") + "identity".length)!.type), "boolean");
  const definition = definitionAt(analysis, source.lastIndexOf("value"));
  assert.equal(definition?.span.start, source.indexOf("value = true"));
  const bad = analyze("let x = 42; let main = missing;");
  assert.equal(bad.diagnostics.length, 1); assert.equal(bad.definitions[0]?.name, "x");
  const partial = analyze("fn id<A>(value: A) -> A =");
  assert.equal(partial.diagnostics.length, 1); assert.ok(partial.tokens.length);
  assert.deepEqual(analyze(identity).diagnostics, []); // Libraries need no main during analysis.
});

test("Ur compilation is repeatable without retained substitutions", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(evaluate(`${identity} let main = identity(42);`), 42);
    assert.equal(evaluate(`${identity} let main = identity(true);`), true);
  }
});

test("Ur merge accepts exactly disjoint closed row pairs", () => {
  const labels = ["x", "constructor", "__proto__"];
  const literal = (mask: number) => `{ ${labels.flatMap((label, i) => mask & (1 << i) ? [`${label}: ${i + 1}`] : []).join(", ")} }`;
  for (let left = 0; left < 8; left++) for (let right = 0; right < 8; right++) {
    const source = `${merge} let main = merge(${literal(left)}, ${literal(right)});`;
    const result = compile(source);
    assert.equal(result.success, (left & right) === 0, source);
    if (result.success) {
      const value = runInNewContext(result.value.javascript, {}, { timeout: 1000 });
      assert.equal(Object.getPrototypeOf(value), null);
      assert.deepEqual(Object.keys(value).sort(), labels.filter((_, i) => (left | right) & (1 << i)).sort());
    }
  }
});

test("Ur disjointness is symmetric but not transitive and never leaks between functions", () => {
  const notTransitive = compile(`
    fn bad<A: Row<Type>, B: Row<Type>, C: Row<Type>>(a: Record<A>, b: Record<B>, c: Record<C>) -> {}
    where disjoint(A, B), disjoint(B, C) = let unused = a ++ c in {};
    let main = 0;
  `);
  assert.equal(notTransitive.success, false);
  if (!notTransitive.success) assert.match(notTransitive.error.message, /Cannot prove disjoint/);
  const noLeak = compile(`${merge}
    fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = a ++ b in {};
    let main = 0;
  `);
  assert.equal(noLeak.success, false);
  if (!noLeak.success) assert.match(noLeak.error.message, /Cannot prove disjoint/);
});
