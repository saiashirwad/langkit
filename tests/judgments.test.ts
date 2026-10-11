import { test } from "node:test";
import assert from "node:assert/strict";
import { check, fail, pure, run, runDetailed, attempt } from "../src/check.ts";
import { createJudgments, type RuleTable } from "../src/judgments.ts";
import { createTrace, traceAt } from "../src/trace.ts";

type Node = { readonly kind: "literal"; readonly value: number } | { readonly kind: "nested"; readonly child: Node } | { readonly kind: "only" };
const rules: RuleTable<Node, string, number> = {
  literal: { mode: "synth", check: "fromSynth", *synth(node) { return { type: "number", term: node.value }; } },
  nested: { mode: "synth", check: "fromSynth", *synth(node, j) { return yield* j.synth(node.child); } },
  only: { mode: "checkingOnly", *check(_node, expected) { return expected.length; } },
};
test("exhaustive ordinary rules and explicit fallback checking", () => {
  const j = createJudgments(rules, { modes: { enter: (expected, body) => body(expected), accept: (actual, expected) => actual.type === expected ? pure(actual.term) : fail("mismatch") } });
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
  const j = createJudgments<Node, string, number>({ ...rules, literal: { mode: "synth", check: "fromSynth", *synth(n) {
    yield* fail("recoverable").recover();
    return { type: "number", term: n.value };
  } } }, { trace, source: () => ({ span: { start: 3, end: 4 }, document: "memory:source" }), modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  const result = runDetailed(check(function* () { yield* j.synth({ kind: "literal", value: 1 }); return yield* trace.snapshot(); }));
  assert(result.status === "completed");
  assert.equal(result.diagnostics[0]!.invocation, result.value[0]!.id);
  assert.equal(result.diagnostics[0]!.code, "judgment.failed");
  assert.deepEqual(result.diagnostics[0]!.origin, { uri: "memory:source", span: { start: 3, end: 4 } });
});
test("void terms do not force an expression representation", () => {
  const j = createJudgments<Node, string, void>({
    literal: { mode: "synth", check: "fromSynth", *synth() { return { type: "number", term: undefined }; } },
    nested: { mode: "unsupported", reason: "no nested schema" },
    only: { mode: "checkingOnly", *check() {} },
  }, { modes: { enter: (t, body) => body(t), accept: () => pure(undefined) } });
  assert.deepEqual(run(j.check({ kind: "literal", value: 1 }, "number")), { success: true, value: undefined });
  assert.equal(run(j.synth({ kind: "nested", child: { kind: "only" } })).success, false);
});
test("trace constraints have actual invocation and source; abandoned attempts disappear", () => {
  const trace = createTrace<string, number>((x) => x, (x) => x);
  const j = createJudgments<Node, string, number>({ ...rules, literal: { mode: "synth", check: "fromSynth", *synth(n) {
    yield* trace.constrain("equal", ["number", "boolean"], "literal policy", fail("bad"));
    return { type: "number", term: n.value };
  } } }, { trace, source: () => ({ span: { start: 2, end: 4 }, document: "memory:test" }), modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  const result = runDetailed(check(function* () {
    yield* attempt(j.synth({ kind: "literal", value: 1 })).recover(pure({ type: "error", term: 0 }));
    yield* j.check({ kind: "only" }, "number");
    return yield* trace.snapshot();
  }));
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.value.map((event) => event.rule), ["only.check"]);
  const successful = runDetailed(check(function* () {
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
