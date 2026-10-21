import assert from "node:assert/strict";
import { test } from "node:test";
import { fail, pure, run } from "../src/check.ts";
import { createJudgments, type RuleTable } from "../src/judgments.ts";

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
test("deep dispatch stays stack safe", () => {
  const j = createJudgments(rules, { modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) } });
  let node: Node = { kind: "literal", value: 7 };
  for (let i = 0; i < 20000; i++) node = { kind: "nested", child: node };
  assert.deepEqual(run(j.synth(node)), { success: true, value: { type: "number", term: 7 } });
  let failing: Node = { kind: "only" };
  for (let i = 0; i < 20000; i++) failing = { kind: "nested", child: failing };
  assert.equal(run(j.synth(failing)).success, false);
});
test("rule spans locate recovered diagnostics inside a rule", () => {
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
    span: () => ({ start: 3, end: 4 }),
    modes: { enter: (t, body) => body(t), accept: (a) => pure(a.term) },
  });
  const result = run(j.synth({ kind: "literal", value: 1 }));
  assert(!result.success);
  assert.deepEqual(result.errors[0].span, { start: 3, end: 4 });
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
