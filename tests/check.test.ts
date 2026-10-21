import assert from "node:assert/strict";
import test from "node:test";
import { check, fail, get, pure, run, scoped, state, within } from "../src/check.ts";
import { add, assign, pruneLink } from "../src/inference.ts";

const counter = state(() => ({ value: 0 }), (cell) => {
  const saved = cell.value;
  return () => {
    cell.value = saved;
  };
});
const increment = get(counter).map((cell) => {
  cell.value += 1;
});

test("public failures collect ordered recovered diagnostics and retain source mapping", () => {
  const result = run(
    fail("inner").context("binding").context("outer").at({ start: 3, end: 5 }).inDocument("file:///unit.ts").recover(
      pure("fallback"),
    ),
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.errors.map(({ message }) => message), ["inner"]);
  assert.deepEqual(result.errors[0], {
    message: "inner",
    context: ["outer", "binding"],
    span: { start: 3, end: 5 },
    origin: { uri: "file:///unit.ts", span: { start: 3, end: 5 } },
    location: { uri: "file:///unit.ts", span: { start: 3, end: 5 } },
  });
});

test("atomic rolls state back on both failure and throw", () => {
  const failed = increment.flatMap(() => fail("nope")).atomic();
  const afterFailure = run(failed.flatMap(() => get(counter)));
  assert.equal(afterFailure.success, false);
  const exception = new Error("boom");
  assert.throws(() =>
    run(
      increment.flatMap(() => {
        throw exception;
      }).atomic(),
    ), exception);
  const untouched = run(get(counter));
  assert.deepEqual(untouched, { success: true, value: { value: 0 } });
});

test("new states allocated inside a failed atomic undo external mutations", () => {
  const external = { value: 0 };
  const local = state(() => external, (target) => {
    const previous = target.value;
    return () => {
      target.value = previous;
    };
  });
  const trial = get(local).map((target) => {
    target.value = 1;
  }).flatMap(() => fail("abort")).atomic();
  assert.equal(run(trial).success, false);
  assert.equal(external.value, 0);
});

test("state is isolated between runs; atomic rolls back only failed or thrown work", () => {
  assert.equal(run(increment).success, true);
  assert.equal(run(get(counter)).success, true);
  const external = { value: 0 };
  const externalState = state(() => external, (cell) => {
    const saved = cell.value;
    return () => {
      cell.value = saved;
    };
  });
  const incrementExternal = get(externalState).map((cell) => {
    cell.value += 1;
  });
  const failed = run(incrementExternal.flatMap(() => fail("stop")).atomic());
  assert.equal(failed.success, false);
  assert.equal(external.value, 0);
  const thrown = new Error("escape");
  assert.throws(() =>
    run(
      incrementExternal.flatMap(() => {
        throw thrown;
      }).atomic(),
    ), thrown);
  assert.equal(external.value, 0);
});

test("generator cleanup runs on yielded failure and thrown first next", () => {
  let closed = 0;
  const yielding = check(function*() {
    try {
      yield* fail("stop");
    } finally {
      closed += 1;
    }
    return 1;
  });
  assert.equal(run(yielding).success, false);
  assert.equal(closed, 1);
  const initialThrow = check(function*() {
    try {
      throw new Error("initial");
    } finally {
      closed += 1;
    }
    return 1;
  });
  assert.throws(() => run(initialThrow), /initial/);
  assert.equal(closed, 2);
});

test("cleanup yielding another check is rejected", () => {
  const invalid = check(function*() {
    try {
      yield* fail("stop");
    } finally {
      yield* pure(undefined);
    }
    return 1;
  });
  assert.throws(() => run(invalid), /generator cleanup/);
});

test("scoped environments are dynamically read-only and updater scopes unwind", () => {
  const environment = scoped<ReadonlyMap<string, number>>(new Map([["base", 1]]));
  const result = run(within(environment, (current) => new Map(current).set("nested", 2), get(environment)));
  assert.deepEqual(result, { success: true, value: new Map([["base", 1], ["nested", 2]]) });
  assert.deepEqual(run(get(environment)), { success: true, value: new Map([["base", 1]]) });
});

test("transactional mutation helpers reverse property and set writes", () => {
  const object: { existing?: number; missing?: number; } = { existing: 1 };
  const set = new Set(["present"]);
  const program = check(function*() {
    yield* assign(object, "existing", 9);
    yield* assign(object, "missing", 7);
    yield* add(set, "added");
    return yield* fail("undo");
  }).atomic();
  assert.equal(run(program).success, false);
  assert.deepEqual(object, { existing: 1 });
  assert.deepEqual([...set], ["present"]);
});

test("mutation journal reverses nested commits, exceptions, and first-use allocations", () => {
  const target = { value: 0 };
  const innerCommit = assign(target, "value", 1).atomic();
  const failedOuter = assign(target, "value", 2)
    .flatMap(() => innerCommit)
    .flatMap(() => fail("outer"))
    .atomic();
  assert.equal(run(failedOuter).success, false);
  assert.equal(target.value, 0);

  assert.throws(() =>
    run(
      assign(target, "value", 3).flatMap(() => {
        throw new Error("throw");
      }).atomic(),
    ), /throw/);
  assert.equal(target.value, 0);

  assert.equal(run(assign(target, "value", 4).flatMap(() => fail("first use")).atomic()).success, false);
  assert.equal(target.value, 0);

  assert.equal(run(assign(target, "value", 5)).success, true);
  assert.equal(target.value, 5);
});

test("pruneLink follows links without compressing any node", () => {
  type Node = { value: string; next?: Node; };
  const root: Node = { value: "root" };
  const middle: Node = { value: "middle", next: root };
  const start: Node = { value: "start", next: middle };
  const resolved = pruneLink(start, (node: Node) => node.next === undefined ? null : node, (node) => node.next);
  assert.equal(resolved, root);
  assert.equal(start.next, middle);
});
test("recovered errors retain execution order and nested failures", () => {
  const recovered = fail("first").recover(pure(undefined)).flatMap(() => fail("second").recover(pure(undefined)));
  const result = run(recovered.flatMap(() => fail("terminal")));
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.errors.map(({ message }) => message), ["first", "second", "terminal"]);
});

test("atomic commits recovered mutations and reports the earliest recovery", () => {
  const external = { value: 0 };
  const key = state(() => external, (cell) => {
    const saved = cell.value;
    return () => {
      cell.value = saved;
    };
  });
  const recovered = get(key).map((cell) => {
    cell.value += 1;
  })
    .flatMap(() => fail("first recovery").recover(pure(undefined)));
  const committed = run(recovered.atomic());
  assert.equal(committed.success, false);
  assert.equal(external.value, 1);
  if (!committed.success) assert.deepEqual(committed.errors.map((error) => error.message), ["first recovery"]);
});

test("recovery propagates programming exceptions without fallback", () => {
  let fallback = false;
  const thrown = pure(undefined).map(() => {
    throw new Error("programming error");
  });
  const other = pure(undefined).map(() => {
    fallback = true;
  });
  assert.throws(() => run(thrown.recover(other)), /programming error/);
  assert.equal(fallback, false);
});

test("forced return bypasses catch and cleanup exceptions unwind enclosing transactions", () => {
  const external = { value: 0 };
  const key = state(() => external, (cell) => {
    const saved = cell.value;
    return () => {
      cell.value = saved;
    };
  });
  const events: string[] = [];
  const inner = check(function*() {
    yield* get(key).map((cell) => {
      cell.value = 1;
    });
    try {
      yield* fail("pending failure");
    } catch {
      events.push("catch");
    } finally {
      events.push("inner");
      throw new Error("cleanup wins");
    }
  });
  const outer = check(function*() {
    try {
      yield* inner.atomic();
    } finally {
      events.push("outer");
    }
  });
  assert.throws(() => run(outer.atomic()), /cleanup wins/);
  assert.deepEqual(events, ["inner", "outer"]);
  assert.equal(external.value, 0);
});
