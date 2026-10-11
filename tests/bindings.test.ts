import { test } from "node:test";
import assert from "node:assert/strict";
import { check, fail, pure, run, get } from "../src/check.ts";
import { createBindings } from "../src/bindings.ts";

test("bindings allocate per execution, scope declarations, and instantiate each reference", () => {
  const b = createBindings({
    monomorphic: (type: symbol) => type,
    instantiate: (_scheme: symbol) => check(function* () { return Symbol("use"); }),
    generalize: (type: symbol) => pure(type),
    parameter: (name: string, type: symbol) => ({ id: Symbol(name), name, type }),
    declare: (name: string, value: { type: symbol; term: symbol }) => pure({ id: Symbol(name), name, type: value.type }),
    reference: (handle: { id: symbol; name: string; type: symbol }) => handle.id,
  });
  const body = b.parameter("x", Symbol("type"), { start: 0, end: 1 }, (handle) => check(function* () {
    const first = yield* b.reference("x", { start: 2, end: 3 });
    const second = yield* b.reference("x", { start: 4, end: 5 });
    assert.equal(first.term, handle.id);
    assert.equal(second.term, handle.id);
    assert.notEqual(first.type, second.type);
    return handle.id;
  }));
  const first = run(body), second = run(body);
  assert(first.success && second.success);
  assert.notEqual(first.value, second.value);
  assert.deepEqual(run(get(b.environment)), { success: true, value: new Map() });
  assert.equal(run(b.let("x", { start: 0, end: 1 }, b.reference("x", { start: 2, end: 3 }), () => fail("unreachable"))).success, false);
});
test("pure lets evaluate outside the new scope, generalize explicitly, and declare exactly once", () => {
  let declared = 0;
  const seen: string[][] = [];
  const b = createBindings<string, string, { id: symbol; name: string }, string>({
    monomorphic: (type) => type,
    instantiate: pure,
    generalize: (type, outer) => { seen.push([...outer]); return pure(`scheme:${type}`); },
    parameter: (name) => ({ id: Symbol(name), name }),
    declare: (name) => check(function* () { declared++; return { id: Symbol(name), name }; }),
    reference: (handle) => handle.name,
  });
  const result = run(b.parameter("outer", "outer-type", { start: 0, end: 1 }, () => b.let("x", { start: 2, end: 3 }, check(function* () {
    assert.equal((yield* get(b.environment)).has("x"), false);
    return { type: "value-type", term: "initial" };
  }), () => check(function* () {
    assert.equal((yield* get(b.environment)).get("x")!.scheme, "scheme:value-type");
    yield* fail("body failure").recover();
    return 1;
  }))));
  assert.equal(result.success, false);
  assert.equal(declared, 1);
  assert.deepEqual(seen, [["outer-type"]]);
  assert.deepEqual(run(get(b.environment)), { success: true, value: new Map() });
});
