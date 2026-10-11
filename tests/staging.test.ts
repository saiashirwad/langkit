import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as S from "../src/staging.ts";
import { emitProgram } from "../src/staging/javascript.ts";
import { makeNode } from "../src/staging/internal.ts";

const run = <A>(program: S.Program<A>, context: object = {}): unknown => runInNewContext(emitProgram(program), context);
test("staging closes a rejected declaration generator and cleanup failures supersede validation", () => {
  for (const materialize of [
    (body: () => Generator<S.Statement, S.Expr<1>, unknown>) => S.build(body),
    (body: () => Generator<S.Statement, S.Expr<1>, unknown>) => S.arrow({ params: [], body }),
  ]) {
    let closed = 0;
    assert.throws(() => materialize(function* () {
      try {
        yield {} as S.Statement;
        return S.number(1);
      } finally { closed++; }
    }), /Invalid staging statement/);
    assert.equal(closed, 1);
    const cleanup = new Error("cleanup");
    assert.throws(() => materialize(function* () {
      try {
        yield {} as S.Statement;
        return S.number(1);
      } finally { throw cleanup; }
    }), error => error === cleanup);
    assert.throws(() => materialize(function* () {
      try {
        yield {} as S.Statement;
        return S.number(1);
      } finally { yield* S.const("cleanup", S.number(0)); }
    }), /Staging cleanup cannot yield declarations/);
  }
});

test("successful staging builders collect declarations yielded from normal finally blocks", () => {
  const program = S.build(function* () {
    try { return S.number(1); }
    finally { yield* S.const("cleanup", S.number(0)); }
  });
  assert.equal(program.statements.length, 1);
  assert.equal(run(program), 1);
});

test("typed constructors build literals, records and typed tuple functions", () => {
  const program = S.build(function* () {
    const capture = yield* S.const("x", S.number(40), S.Number);
    const fn = yield* S.const("f", S.arrow({ params: [S.param("x", S.Number), S.param("label", S.String)], body: function* ([x, label]) {
      const sum = yield* S.const("sum", S.binary("+", capture, x));
      return S.object({ sum, label });
    } }));
    return S.prop(S.call(fn, S.number(2), S.string("answer")), "sum");
  });
  assert.equal(run(program), 42);
  assert.equal(program.result.shape.kind, "number");
  assert.equal(run(S.build(function* () { return S.prop(S.object({ ["__proto__"]: S.number(11) }), "__proto__"); })), 11);
});
test("declaration builders are reusable with fresh binding identities", () => {
  const declaration = S.const("same", S.number(3));
  const program = S.build(function* () {
    const a = yield* declaration; const b = yield* declaration;
    assert.notEqual(a.id, b.id); return S.binary("+", a, b);
  });
  assert.equal(run(program), 6);
});
test("normal generator declarations execute before the final expression and branches remain lazy", () => {
  const tick = S.external("tick", S.functionType([S.Number], S.Number));
  const trace: number[] = [];
  const branch = (n: number) => S.call(S.arrow({ params: [], body: function* () {
    const value = yield* S.const("value", S.call(tick, S.number(n))); return value;
  } }));
  const program = S.build(function* () {
    const first = yield* S.const("first", S.call(tick, S.number(1)));
    return S.object({ first, chosen: S.cond(S.boolean(false), branch(2), branch(3)), last: S.call(tick, S.number(4)) });
  });
  assert.equal(JSON.stringify(run(program, { tick: (n: number) => { trace.push(n); return n; } })), '{"first":1,"chosen":3,"last":4}');
  assert.deepEqual(trace, [1, 3, 4]);
});
test("scope is lexical, nonrecursive and checked before emission", () => {
  const parameter = S.param("x", S.Number);
  assert.throws(() => S.build(function* () { return S.ref(parameter); }), /Out-of-scope/);
  let escaped: S.Ref<1> | undefined;
  const inner = S.arrow({ params: [], body: function* () { escaped = yield* S.const("x", S.number(1)); return escaped; } });
  assert.throws(() => S.build(function* () { yield* S.const("f", inner); return escaped!; }), /Out-of-scope/);
  const later = S.const("later", S.number(2));
  const iterator = later[Symbol.iterator](); const statement = iterator.next().value as S.Statement; const reference = iterator.next().value as S.Ref<2>;
  const early = S.arrow({ params: [], body: function* () { return reference; } });
  assert.throws(() => S.build(function* () { yield* S.const("f", early); yield statement; return reference; }), /Out-of-scope/);
});
test("duplicate exact identities and cycles are rejected", () => {
  const iterator = S.const("x", S.number(1))[Symbol.iterator]();
  const statement = iterator.next().value as S.Statement; const reference = iterator.next().value as S.Ref<1>;
  assert.throws(() => S.build(function* () { yield statement; yield statement; return reference; }), /Duplicate/);
  const parameter = S.param("x", S.Number);
  const repeated = S.arrow({ params: [parameter, parameter], body: function* ([x]) { return x; } });
  assert.throws(() => S.build(function* () { return repeated; }), /Duplicate/);
  const body = { statements: [], result: S.number(1) as S.Expr<unknown> };
  const cycle = makeNode("arrow", { kind: "unknown" }, { params: [], body }) as S.Expr<unknown>;
  body.result = cycle;
  assert.throws(() => S.build(function* () { return cycle; }), /Cyclic/);
});
test("constructor and emitter trust boundaries reject forged witnesses, expressions, statements and programs", () => {
  assert.throws(() => S.param("x", 1 as unknown as S.Type<number>), /Type witness/);
  assert.throws(() => S.param("x", { shape: { kind: "number" } } as unknown as S.Type<number>), /Type witness/);
  assert.throws(() => S.binary("+", S.boolean(true) as unknown as S.Expr<number>, S.number(1)), /type mismatch/);
  assert.throws(() => S.const("bad", S.string("x") as unknown as S.Expr<number>, S.Number), /type mismatch/);
  assert.throws(() => S.build(function* () { return { kind: "literal" } as unknown as S.Expr<number>; }), /Invalid staging expression/);
  assert.throws(() => S.build(function* () { yield {} as S.Statement; return S.number(1); }), /Invalid staging statement/);
  assert.throws(() => emitProgram({ statements: [], result: S.number(1) } as unknown as S.Program<1>), /built staging Program/);
  const fn = S.arrow({ params: [S.param("x", S.Number)], body: function* ([x]) { return x; } });
  const dynamicCall = S.call as unknown as (fn: S.Expr<unknown>, ...args: S.Expr<unknown>[]) => S.Expr<unknown>;
  assert.throws(() => dynamicCall(fn as unknown as S.Expr<unknown>, S.string("bad") as unknown as S.Expr<unknown>), /type mismatch/);
  assert.throws(() => dynamicCall(fn as unknown as S.Expr<unknown>), /arity/);
  assert.throws(() => dynamicCall(S.number(1) as unknown as S.Expr<unknown>), /requires a function/);
});
test("unknown witnesses retain runtime-checked existential application without static numeric proof", () => {
  const fn = S.arrow({ params: [S.param("x", S.Unknown)], body: function* ([x]) { return x; } });
  const program = S.build(function* () { return S.call(fn, S.number(42)); });
  assert.equal(run(program), 42);
  assert.equal(program.result.shape.kind, "unknown");
});
test("emission preserves negative numbers, negative zero and external names without lexical collisions", () => {
  assert.equal(run(S.build(function* () { return S.binary("-", S.number(-1), S.number(-2)); })), 1);
  assert.ok(Object.is(run(S.build(function* () { return S.number(-0); })), -0));
  const program = S.build(function* () {
    yield* S.const("local", S.number(1)); return S.external("v0", S.Number);
  });
  assert.equal(run(program, { v0: 42 }), 42);
});
