import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { attempt, check, choice, fail, lookup, run, scoped, type Check } from "langkit";
import { create, type Body, type Declaration, type Reference, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { printingJavaScript } from "langkit/javascript/printing";
import { printing } from "langkit/operations/printing";

const printingSet = printing<string>();
const code = create<string>().use(printingSet);
const javascript = createJavaScriptEmitter(
  coreJavaScript(code.coreDescriptors),
  printingJavaScript(printingSet.descriptors),
);
const emptyBody = (result: Value<string>): Body<string> => ({ declarations: [], result });
const evaluate = (body: Body<string>, output: unknown[] = []) => runInNewContext(
  javascript.emit(code.program(body)),
  { console: { log: (value: unknown) => output.push(value) } },
  { timeout: 1000 },
);
const number = (value: number) => code.literal("number", value);

test("one elaboration body reused in one run owns distinct declaration snapshots", () => {
  const api = elaboration(code);
  const body = api.body(function* () { return yield* declare("local", number(42)); });
  const result = run(check(function* () { return [yield* body, yield* body]; }));
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
  const api = elaboration(code);
  let published: Body<string> | undefined;
  run(attempt(check(function* () {
    published = yield* api.body(function* () { return yield* declare("local", number(42)); });
    yield* fail("abandon");
  })));
  assert.ok(published);
  assert.equal(published.declarations.length, 1);
  assert.equal(evaluate(published), 42);
});

test("nested active collectors restore the outer declaration collection", () => {
  const api = elaboration(code);
  const result = run(api.body(function* () {
    yield* declare("before", number(1));
    const inner = yield* api.body(function* () { return yield* declare("inner", number(42)); });
    assert.deepEqual(inner.declarations.map((d) => d.binding.name), ["inner"]);
    return yield* declare("after", number(42));
  }));
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.value.declarations.map((d) => d.binding.name), ["before", "after"]);
    assert.equal(evaluate(result.value), 42);
  }
});

function* declare(name: string, value: Value<string>): Generator<Declaration<string>, Reference<string>, unknown> {
  return yield* code.declare(name, value);
}

function* declareSum(): Generator<Declaration<string>, Value<string>, unknown> {
  const left = yield* declare("left", number(19));
  const right = yield* declare("right", number(23));
  return code.binary("number", "+", left, right);
}

test("declarations retain yield order and their returned references evaluate", () => {
  const body = code.body(declareSum);
  assert.deepEqual(body.declarations.map(({ binding }) => binding.name), ["left", "right"]);
  assert.equal(evaluate(body), 42);
});

test("reusable body factories create fresh bindings without accumulating declarations", () => {
  function* factory(): Generator<Declaration<string>, Value<string>, unknown> {
    const local = yield* declare("local", number(42));
    return local;
  }
  const first = code.body(factory);
  const second = code.body(factory);
  assert.equal(first.declarations.length, 1);
  assert.equal(second.declarations.length, 1);
  assert.notEqual(first.declarations[0]!.binding.id, second.declarations[0]!.binding.id);
  assert.equal(evaluate(first), 42);
  assert.equal(evaluate(second), 42);
});

test("nested body factories defer target effects until runtime", () => {
  const output: unknown[] = [];
  const api = elaboration(code);
  const nested = api.body(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
    const nestedResult = yield* api.scope(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
      const message = yield* declare("message", code.literal("string", "lazy"));
      yield* declare("scopeEffect", code.print("unit", message));
      return number(7);
    });
    const functionValue = code.fn("function", code.binding("arg", "number"), function* () {
      yield* declare("functionEffect", code.print("unit", number(42)));
      return number(42);
    });
    const fn = yield* declare("fn", functionValue);
    return code.binary("number", "+", code.call("number", fn, number(1)), nestedResult);
  });
  const result = run(nested);
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(output, []);
    assert.equal(evaluate(result.value, output), 49);
    assert.deepEqual(output, [42, "lazy"]);
  }
});

test("yield-star helpers compose raw declaration generators with checks", () => {
  const api = elaboration(code);
  function* helper(): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
    const sum = yield* declareSum();
    const twice = yield* declare("twice", code.binary("number", "*", sum, number(2)));
    return twice;
  }
  const body = run(api.body(helper));
  assert.equal(body.success, true);
  if (body.success) {
    assert.deepEqual(body.value.declarations.map(({ binding }) => binding.name), ["left", "right", "twice"]);
    assert.equal(evaluate(body.value), 84);
  }
});

test("program construction validates descriptor scope and duplicate identities", () => {
  const local = code.binding("local", "number");
  assert.throws(() => code.program(emptyBody(code.ref(local))));
  const duplicate = code.binding("duplicate", "number");
  const body: Body<string> = {
    declarations: [{ binding: duplicate, value: number(1) }, { binding: duplicate, value: number(2) }],
    result: code.ref(duplicate),
  };
  assert.throws(() => code.program(body));
});

test("mixed elaboration preserves diagnostics and rolls back abandoned declarations", () => {
  const api = elaboration(code);
  const environment = scoped<ReadonlyMap<string, Value<string>>>(new Map([
    ["firstValue", number(19)],
    ["secondValue", number(23)],
  ]));
  const computation = api.body(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
    const firstValue = yield* lookup(environment, "firstValue").context("first");
    const first = yield* declare("first", firstValue);
    const secondValue = yield* lookup(environment, "secondValue").context("second");
    const second = yield* declare("second", secondValue);
    return code.binary("number", "+", first, second);
  });
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

  const alternatives = api.body(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
    const value = yield* choice(
      api.check(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
        yield* declare("abandoned", number(1));
        return yield* fail("abandoned branch").context("choice");
      }),
      api.check(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
        return yield* declare("kept", number(42));
      }),
    );
    return value;
  });
  const selected = run(alternatives);
  assert.equal(selected.success, true);
  if (selected.success) {
    assert.deepEqual(selected.value.declarations.map(({ binding }) => binding.name), ["kept"]);
    assert.equal(evaluate(selected.value), 42);
  }

  let closed = false;
  const failed = run(api.body(function* (): Generator<Check<unknown> | Declaration<string>, Value<string>, unknown> {
    try {
      yield* declare("beforeFailure", number(1));
      const missing = yield* fail("missing value").context("declaration input");
      return yield* declare("broken", missing);
    } finally {
      closed = true;
    }
  }));
  assert.equal(closed, true);
  assert.equal(failed.success, false);
  if (!failed.success) {
    assert.equal(failed.errors[0]!.message, "missing value");
    assert.deepEqual(failed.errors[0]!.context, ["declaration input"]);
  }
});
