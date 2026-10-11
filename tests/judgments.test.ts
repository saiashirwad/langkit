import assert from "node:assert/strict";
import { test } from "node:test";
import { attempt, check, fail, pure, run, runDetailed } from "../src/check.ts";
import { createJudgments, type RuleTable } from "../src/judgments.ts";
import { createTrace, traceAt } from "../src/trace.ts";

type Node =
  | { readonly kind: "literal"; readonly value: number; }
  | { readonly kind: "nested"; readonly child: Node; }
  | { readonly kind: "only"; };
const rules: RuleTable<Node, string, number> = {
  literal: {
    mode: "synth",
    check: "fromSynth",
    *synth(node) {
      return { type: "number", term: node.value };
    },
  },
  nested: {
    mode: "synth",
    check: "fromSynth",
    *synth(node, j) {
      return yield* j.synth(node.child);
    },
  },
  only: {
    mode: "checkingOnly",
    *check(_node, expected) {
      return expected.length;
    },
  },
};
test("exhaustive ordinary rules and explicit fallback checking", () => {
  const j = createJudgments(rules, {
    modes: {
      enter: (expected, body) => body(expected),
      accept: (actual, expected) => actual.type === expected ? pure(actual.term) : fail("mismatch"),
    },
  });
  assert.deepEqual(run(j.synth({ kind: "literal", value: 3 })), { success: true, value: { type: "number", term: 3 } });
  assert.deepEqual(run(j.check({ kind: "only" }, "number")), { success: true, value: 6 });
  assert.equal(run(j.synth({ kind: "only" })).success, false);
  assert.equal(run(j.check({ kind: "literal", value: 1 }, "boolean")).success, false);
});
test("instrumented deep dispatch stays stack safe", () => {
  const trace = createTrace<string, number>((x) => x, (x) => x);
  const j = createJudgments(rules, { trace, modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  let node: Node = { kind: "literal", value: 7 };
  for (let i = 0; i < 20000; i++) node = { kind: "nested", child: node };
  assert.deepEqual(run(j.synth(node)), { success: true, value: { type: "number", term: 7 } });
  let failing: Node = { kind: "only" };
  for (let i = 0; i < 20000; i++) failing = { kind: "nested", child: failing };
  const failure = run(j.synth(failing));
  assert.equal(failure.success, false);
  if (!failure.success) assert.equal(failure.errors[0]!.code, "judgment.synthesis-unavailable");
});
test("source attribution applies to recovered diagnostics inside a rule", () => {
  const trace = createTrace<string, number>((x) => x, (x) => x);
  const j = createJudgments<Node, string, number>({
    ...rules,
    literal: {
      mode: "synth",
      check: "fromSynth",
      *synth(n) {
        yield* fail("recoverable").recover();
        return { type: "number", term: n.value };
      },
    },
  }, {
    trace,
    source: () => ({ span: { start: 3, end: 4 }, document: "memory:source" }),
    modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) },
  });
  const result = runDetailed(check(function*() {
    yield* j.synth({ kind: "literal", value: 1 });
    return yield* trace.snapshot();
  }));
  assert(result.status === "completed");
  assert.equal(result.diagnostics[0]!.invocation, result.value[0]!.id);
  assert.equal(result.diagnostics[0]!.code, "judgment.failed");
  assert.deepEqual(result.diagnostics[0]!.origin, { uri: "memory:source", span: { start: 3, end: 4 } });
});
test("void terms do not force an expression representation", () => {
  const j = createJudgments<Node, string, void>({
    literal: {
      mode: "synth",
      check: "fromSynth",
      *synth() {
        return { type: "number", term: undefined };
      },
    },
    nested: { mode: "unsupported", reason: "no nested schema" },
    only: { mode: "checkingOnly", *check() {} },
  }, { modes: { enter: (t, body) => body(t), accept: () => pure(undefined) } });
  assert.deepEqual(run(j.check({ kind: "literal", value: 1 }, "number")), { success: true, value: undefined });
  assert.equal(run(j.synth({ kind: "nested", child: { kind: "only" } })).success, false);
});
test("uncollected dispatch still gives diagnostics execution-local rule identities", () => {
  const j = createJudgments(rules, { modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  const node: Node = { kind: "nested", child: { kind: "only" } };
  const first = run(j.synth(node)), second = run(j.synth(node));
  assert(!first.success && !second.success);
  assert.equal(first.errors[0]!.rule, "only.synth");
  assert(first.errors[0]!.parentInvocation);
  assert.notEqual(first.errors[0]!.invocation, second.errors[0]!.invocation);
});
test("successful finally yields remain legal inside ordinary judgment rules", () => {
  const j = createJudgments<Node, string, number>({
    ...rules,
    literal: {
      mode: "synth",
      check: "fromSynth",
      *synth(n) {
        try {
          return { type: "number", term: n.value };
        } finally {
          yield* pure(undefined);
        }
      },
    },
  }, { modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  assert.deepEqual(run(j.synth({ kind: "literal", value: 1 })), { success: true, value: { type: "number", term: 1 } });
});
test("configured rule callbacks are snapshotted at registry construction", () => {
  const mutable = { ...rules, literal: { ...rules.literal } };
  const j = createJudgments<Node, string, number>(mutable, {
    modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) },
  });
  Object.assign(mutable.literal, {
    *synth() {
      return { type: "changed", term: 99 };
    },
  });
  assert.deepEqual(run(j.synth({ kind: "literal", value: 1 })), { success: true, value: { type: "number", term: 1 } });
});
test("publication applies supplied snapshots and retains explicit predecessor links", () => {
  const trace = createTrace<{ cell: number; }, number, number, number>((type) => type.cell, (term) => term);
  const type = { cell: 1 };
  const result = run(check(function*() {
    yield* trace.invocation({ rule: "snapshot", expected: type }, (id) =>
      check(function*() {
        yield* trace.constrain("equal", [type], "explicit reason", pure(undefined), [id]);
        yield* trace.result(id, type, 3);
      }));
    const snapshot = yield* trace.snapshot();
    type.cell = 2;
    return snapshot;
  }));
  assert(result.success);
  assert.equal(result.value[0]!.expected, 1);
  assert.deepEqual(result.value[1]!.operands, [1]);
  assert.deepEqual(result.value[1]!.causedBy, [result.value[0]!.id]);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value[1]!.operands), true);
});
test("trace constraints have actual invocation and source; abandoned attempts disappear", () => {
  const trace = createTrace<string, number>((x) => x, (x) => x);
  const j = createJudgments<Node, string, number>({
    ...rules,
    literal: {
      mode: "synth",
      check: "fromSynth",
      *synth(n) {
        yield* trace.constrain("equal", ["number", "boolean"], "literal policy", fail("bad"));
        return { type: "number", term: n.value };
      },
    },
  }, {
    trace,
    source: () => ({ span: { start: 2, end: 4 }, document: "memory:test" }),
    modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) },
  });
  const result = runDetailed(check(function*() {
    yield* attempt(j.synth({ kind: "literal", value: 1 })).recover(pure({ type: "error", term: 0 }));
    yield* j.check({ kind: "only" }, "number");
    return yield* trace.snapshot();
  }));
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.deepEqual(result.value.flatMap((event) => event.rule ? [event.rule] : []), ["only.check"]);
  }
  const successful = runDetailed(check(function*() {
    yield* j.synth({ kind: "literal", value: 1 }).recover(pure({ type: "error", term: 0 }));
    return yield* trace.snapshot();
  }));
  assert.equal(successful.status, "completed");
  if (successful.status === "completed") {
    assert.equal(traceAt(successful.value, 3).length, 2);
    assert.equal(successful.value[1]!.parent, successful.value[0]!.id);
    assert.equal(successful.diagnostics[0]!.invocation, successful.value[0]!.id);
    assert.equal(successful.diagnostics[0]!.reasons![0], successful.value[1]!.id);
    assert.equal(successful.value[1]!.document, "memory:test");
  }
});
