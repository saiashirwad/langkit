import { type Check, check, fail, lookup, run, scoped } from "langkit";
import * as ir from "langkit/ir";
import type { Body, Value } from "langkit/ir";
import { emit } from "langkit/javascript";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const evaluate = (body: Body<string>, output: unknown[] = []) =>
  runInNewContext(emit(body), { console: { log: (value: unknown) => output.push(value) } }, { timeout: 1000 });
const number = (value: number) => ir.literal("number", value);

test("one body check reused in one run owns distinct declaration snapshots", () => {
  const body = ir.body(ir.declare("local", number(42)));
  const result = run(check(function*() {
    return [yield* body, yield* body];
  }));
  assert.equal(result.success, true);
  if (!result.success) return;
  const [first, second] = result.value;
  assert.ok(first && second);
  assert.notEqual(first.declarations, second.declarations);
  assert.equal(first.declarations.length, 1);
  assert.equal(second.declarations.length, 1);
  assert.notEqual(first.declarations[0]!.binding.id, second.declarations[0]!.binding.id);
  assert.equal(evaluate(first), 42);
  assert.equal(evaluate(second), 42);
});

test("published body survives enclosing speculative rollback", () => {
  let published: Body<string> | undefined;
  run(
    check(function*() {
      published = yield* ir.body(ir.declare("local", number(42)));
      yield* fail("abandon");
    }).atomic(),
  );
  assert.ok(published);
  assert.equal(published.declarations.length, 1);
  assert.equal(evaluate(published), 42);
});

test("nested bodies restore the outer declaration list", () => {
  const result = run(ir.body(check(function*() {
    yield* ir.declare("before", number(1));
    const inner = yield* ir.body(ir.declare("inner", number(42)));
    assert.deepEqual(inner.declarations.map((d) => d.binding.name), ["inner"]);
    return yield* ir.declare("after", number(42));
  })));
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.value.declarations.map((d) => d.binding.name), ["before", "after"]);
    assert.equal(evaluate(result.value), 42);
  }
});

test("declaring outside a body throws", () => {
  assert.throws(() => run(ir.declare("orphan", number(1))), /IR declarations need an enclosing body/);
});

test("helper checks compose declarations in order", () => {
  const sum: Check<Value<string>> = check(function*() {
    const left = yield* ir.declare("left", number(19));
    const right = yield* ir.declare("right", number(23));
    return ir.binary("number", "+", left, right);
  });
  const body = run(ir.body(check(function*() {
    return yield* ir.declare("twice", ir.binary("number", "*", yield* sum, number(2)));
  })));
  assert.equal(body.success, true);
  if (body.success) {
    assert.deepEqual(body.value.declarations.map(({ binding }) => binding.name), ["left", "right", "twice"]);
    assert.equal(evaluate(body.value), 84);
  }
});

test("nested bodies defer target effects until runtime", () => {
  const output: unknown[] = [];
  const nested = ir.body(check(function*() {
    const nestedResult = yield* ir.scope(check(function*() {
      const message = yield* ir.declare("message", ir.literal("string", "lazy"));
      yield* ir.declare("scopeEffect", ir.print("unit", message));
      return number(7);
    }));
    const functionBody = yield* ir.body(check(function*() {
      yield* ir.declare("functionEffect", ir.print("unit", number(42)));
      return number(42);
    }));
    const fn = yield* ir.declare("fn", ir.fn("function", ir.binding("arg", "number"), functionBody));
    return ir.binary("number", "+", ir.call("number", fn, number(1)), nestedResult);
  }));
  const result = run(nested);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(output, []);
    assert.equal(evaluate(result.value, output), 49);
    assert.deepEqual(output, [42, "lazy"]);
  }
});

test("elaboration preserves diagnostics and rolls back abandoned declarations", () => {
  const environment = scoped<ReadonlyMap<string, Value<string>>>(
    new Map([
      ["firstValue", number(19)],
      ["secondValue", number(23)],
    ]),
  );
  const computation = ir.body(check(function*() {
    const firstValue = yield* lookup(environment, "firstValue").context("first");
    const first = yield* ir.declare("first", firstValue);
    const secondValue = yield* lookup(environment, "secondValue").context("second");
    const second = yield* ir.declare("second", secondValue);
    return ir.binary("number", "+", first, second);
  }));
  const firstRun = run(computation);
  assert.equal(firstRun.success, true);
  if (firstRun.success) {
    assert.deepEqual(firstRun.value.declarations.map(({ binding }) => binding.name), ["first", "second"]);
    assert.equal(evaluate(firstRun.value), 42);
  }
  const repeated = run(computation);
  assert.equal(repeated.success, true);
  if (repeated.success && firstRun.success) {
    assert.notEqual(repeated.value.declarations[0]!.binding.id, firstRun.value.declarations[0]!.binding.id);
  }

  let selected: Body<string> | undefined;
  const alternatives = check(function*() {
    selected = yield* ir.body(
      check(function*() {
        yield* ir.declare("abandoned", number(1));
        return yield* fail("abandoned branch").context("choice");
      }).atomic().recover(ir.declare("kept", number(42))),
    );
  });
  const alternativesRun = run(alternatives);
  assert.equal(alternativesRun.success, false);
  if (!alternativesRun.success) {
    assert.deepEqual(alternativesRun.errors.map(({ message }) => message), ["abandoned branch"]);
  }
  assert.ok(selected);
  assert.deepEqual(selected.declarations.map(({ binding }) => binding.name), ["kept"]);
  assert.equal(evaluate(selected), 42);

  let closed = false;
  const failed = run(ir.body(check(function*() {
    try {
      yield* ir.declare("beforeFailure", number(1));
      const missing = yield* fail("missing value").context("declaration input");
      return yield* ir.declare("broken", missing);
    } finally {
      closed = true;
    }
  })));
  assert.equal(closed, true);
  assert.equal(failed.success, false);
  if (!failed.success) {
    assert.equal(failed.errors[0]!.message, "missing value");
    assert.deepEqual(failed.errors[0]!.context, ["declaration input"]);
  }
});
