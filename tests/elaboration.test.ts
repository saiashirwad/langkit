import assert from "node:assert/strict";
import { test } from "node:test";
import { attempt, check, fail, pure, runDetailed } from "../src/check.ts";
import { elaborate } from "../src/elaboration.ts";
import { createCompiler } from "../src/language.ts";
import { createTrace } from "../src/trace.ts";

test("detailed runs retain recovered return values and exceptions remain exceptions", () => {
  assert.deepEqual(runDetailed(fail("bad").recover(pure(2))), {
    status: "completed",
    value: 2,
    diagnostics: [{ message: "bad", context: [] }],
  });
  assert.throws(() =>
    runDetailed(check(function*() {
      throw new Error("host");
    })), /host/);
});
test("only clean finalization publishes checked artifacts", () => {
  const base = { elaborate: pure(1), snapshot: (x: number) => x, facts: pure([]) };
  assert.equal(elaborate({ ...base, finalize: (x) => pure(x + 1) }).status, "checked");
  assert.equal(
    elaborate({
      ...base,
      elaborate: fail("hole").recover(pure(1)),
      finalize: () => {
        throw new Error("must not finalize");
      },
    }).status,
    "recovered",
  );
  assert.equal(elaborate({ ...base, finalize: () => fail("obligation") }).status, "recovered");
  assert.equal(elaborate({ ...base, finalize: () => fail("bad").recover(pure(1)) }).status, "recovered");
  assert.equal(elaborate({ ...base, elaborate: fail("no term"), finalize: () => pure(1) }).status, "failed");
});
test("fresh compiler configurations and detached snapshots", () => {
  const compiler = createCompiler({
    configure: (source: number) => {
      const trace = createTrace<number, number>((x) => x, (x) => x);
      return {
        elaborate: trace.invocation({ rule: "entry" }, () => pure(source)),
        finalize: (x: number) => pure(x),
        snapshot: (x: number) => x,
        facts: trace.snapshot(),
      };
    },
    emit: (x: number) => String(x),
  });
  const first = compiler.elaborate(1), second = compiler.elaborate(2);
  assert(first.status === "checked" && second.status === "checked");
  assert.equal(compiler.emit(first.artifact), "1");
  assert.notEqual(first.facts[0]!.id, second.facts[0]!.id);
  assert.throws(() => compiler.emit({ value: 1 } as typeof first.artifact), /clean finalized artifact/);
  assert.throws(() => compiler.emit(Object.create(Object.getPrototypeOf(first.artifact))), /clean finalized artifact/);
});
test("finalization and observation host exceptions propagate; observation failure cannot publish invented facts", () => {
  const base = { elaborate: pure(1), snapshot: (x: number) => x, facts: pure([]) };
  assert.throws(() =>
    elaborate({
      ...base,
      finalize: () =>
        check(function*() {
          throw new Error("host finalizer");
        }),
    }), /host finalizer/);
  assert.throws(
    () => elaborate({ ...base, finalize: pure, facts: fail("observation policy failure") }),
    /Observation publication must complete/,
  );
});
test("speculation rolls back observations without reusing retained diagnostic identities", () => {
  const trace = createTrace<string, void>((x) => x, (x) => x);
  const result = elaborate({
    elaborate: check(function*() {
      yield* attempt(trace.invocation({ rule: "abandoned" }, () => fail("bad"))).recover();
      yield* trace.invocation({ rule: "retained" }, () => pure(undefined));
      return 1;
    }),
    finalize: (x: number) => pure(x),
    snapshot: (x: number) => x,
    facts: trace.snapshot(),
  });
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.facts.map((event) => event.rule), ["retained"]);
});
test("atomic rollback never lets a retained diagnostic name a later unrelated constraint", () => {
  const trace = createTrace<string, void>((x) => x, (x) => x);
  const result = runDetailed(check(function*() {
    yield* trace.constrain("equal", ["a", "b"], "discarded", fail("bad")).atomic().recover();
    yield* trace.constrain("equal", ["c", "c"], "retained", pure(undefined));
    return yield* trace.snapshot();
  }));
  assert(result.status === "completed");
  assert.equal(result.value.length, 1);
  assert.notEqual(result.diagnostics[0]!.reasons![0], result.value[0]!.id);
});
