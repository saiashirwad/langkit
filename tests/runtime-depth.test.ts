import assert from "node:assert/strict";
import { test } from "node:test";
import { Check, attempt, check, choice, fail, get, pure, run, scoped, within } from "langkit";

for (const kind of ["flatMap", "map", "generator", "scope"] as const) {
  test(`20,000 nested ${kind} checks use bounded native stack`, () => {
    const key = scoped(0);
    let computation: Check<number> = pure(0);
    for (let i = 0; i < 20_000; i++) {
      const child = computation;
      computation = kind === "flatMap" ? child.flatMap((n) => pure(n + 1))
        : kind === "map" ? child.map((n) => n + 1)
        : kind === "generator" ? check(function* () { return (yield* child) + 1; })
        : within(key, (n) => n + 1, child);
    }
    assert.deepEqual(run(computation), { success: true, value: kind === "scope" ? 0 : 20_000 });
    assert.deepEqual(run(get(key)), { success: true, value: 0 });
  });
}

test("2,000 nested transactions and ordered choices use bounded native stack", () => {
  let computation = pure(42);
  for (let i = 0; i < 2_000; i++) computation = choice(fail("no"), attempt(computation.atomic()));
  assert.deepEqual(run(computation), { success: true, value: 42 });
});

test("forced cleanup is inner-to-outer and the outer exception wins", () => {
  const events: string[] = [];
  const inner = check(function* () {
    try { yield* fail("terminal"); } finally { events.push("inner"); throw new Error("inner cleanup"); }
  });
  const outer = check(function* () {
    try { yield* inner; } finally { events.push("outer"); throw new Error("outer cleanup"); }
  });
  assert.throws(() => run(outer.atomic()), /outer cleanup/);
  assert.deepEqual(events, ["inner", "outer"]);
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
