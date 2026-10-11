import assert from "node:assert/strict";
import { test } from "node:test";
import { Check, attempt, check, choice, fail, get, pure, run, scoped, within } from "langkit";

for (const kind of ["flatMap", "map", "generator", "scope"] as const) {
  test(`20,000 nested ${kind} checks use bounded native stack`, () => {
    const key = scoped(0);
    let computation: Check<number> = kind === "scope" ? get(key) : pure(0);
    for (let i = 0; i < 20_000; i++) {
      const child = computation;
      computation = kind === "flatMap" ? child.flatMap((n) => pure(n + 1))
        : kind === "map" ? child.map((n) => n + 1)
        : kind === "generator" ? check(function* () { return (yield* child) + 1; })
        : within(key, (n) => n + 1, child);
    }
    assert.deepEqual(run(computation), { success: true, value: 20_000 });
    assert.deepEqual(run(get(key)), { success: true, value: 0 });
  });
}

test("20,000 recursively produced yielded Checks use bounded native stack", () => {
  const descend = (depth: number): Check<number> => check(function* () {
    return depth === 0 ? 0 : (yield* descend(depth - 1)) + 1;
  });
  assert.deepEqual(run(descend(20_000)), { success: true, value: 20_000 });
});

test("2,000 nested transactions and ordered choices use bounded native stack", () => {
  let computation = pure(42);
  for (let i = 0; i < 2_000; i++) computation = choice(fail("no"), attempt(computation.atomic()));
  assert.deepEqual(run(computation), { success: true, value: 42 });
});

for (const pending of ["failure", "exception"] as const) test(`forced cleanup overrides pending ${pending} inner-to-outer`, () => {
  const events: string[] = [];
  const inner = check(function* () {
    try {
      yield* pending === "failure" ? fail("terminal") : pure(undefined).map(() => { throw new Error("pending exception"); });
    } finally { events.push("inner"); throw new Error("inner cleanup"); }
  });
  const outer = check(function* () {
    try { yield* inner; } finally { events.push("outer"); throw new Error("outer cleanup"); }
  });
  assert.throws(() => run(outer.atomic()), /outer cleanup/);
  assert.deepEqual(events, ["inner", "outer"]);
});

test("custom primitive callbacks can synchronously consume a built-in step", () => {
  let child = pure(0);
  for (let i = 0; i < 20_000; i++) child = child.map((value) => value + 1);
  const custom = new Check((runtime) => child.step(runtime));
  assert.deepEqual(run(custom), { success: true, value: 20_000 });
});

test("forced cleanup yields are rejected without execution and outer cleanup runs", () => {
  let executed = false;
  let closed = false;
  const inner = check(function* () {
    try { yield* fail("terminal"); } finally {
      yield* new Check(() => { executed = true; return { ok: true, value: undefined }; });
    }
  });
  assert.throws(() => run(check(function* () {
    try { yield* inner; } finally { closed = true; }
  })), TypeError);
  assert.equal(executed, false);
  assert.equal(closed, true);
});

test("ordinary successful finally yields remain executable", () => {
  let executed = false;
  assert.deepEqual(run(check(function* () {
    try { return 42; } finally { yield* pure(undefined).map(() => { executed = true; }); }
  })), { success: true, value: 42 });
  assert.equal(executed, true);
});
