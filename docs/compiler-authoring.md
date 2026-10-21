# Build a compiler with typed judgments

Bring your own AST, semantic types, and term representation. Use `createJudgments` to dispatch exhaustive synthesis and checking rules.

## Define rules for your AST

This complete compiler accepts a numeric AST and emits JavaScript. The rules use the supported solver rather than a local unifier.

```ts
import { run } from "langkit";
import { createJudgments, type RuleTable } from "langkit/judgments";
import * as rank from "langkit/types/higher-rank";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Expr =
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "add"; readonly left: Expr; readonly right: Expr; };

const rules: RuleTable<Expr, rank.Type, string> = {
  number: {
    mode: "synth",
    check: "fromSynth",
    *synth(node) {
      return { type: rank.number, term: String(node.value) };
    },
  },
  add: {
    mode: "synth",
    check: "fromSynth",
    *synth(node, judgments) {
      const left = yield* judgments.check(node.left, rank.number);
      const right = yield* judgments.check(node.right, rank.number);
      return { type: rank.number, term: `(${left}+${right})` };
    },
  },
};
const judgments = createJudgments(rules, {
  modes: {
    enter: (expected, body) => body(expected),
    accept: (actual, expected) => rank.unify(actual.type, expected).map(() => actual.term),
  },
});

const outcome = run(judgments.synth({
  kind: "add",
  left: { kind: "number", value: 19 },
  right: { kind: "number", value: 23 },
}));
assert.ok(outcome.success);
assert.equal(rank.show(outcome.value.type), "number");
assert.equal(runInNewContext(outcome.value.term), 42);
```

Give each AST kind a rule. Use `mode: "checkingOnly"` for a form that requires an expected type. Use `mode: "unsupported"` with a reason for a deliberate rejection. Select `check: "fromSynth"` explicitly when checking means synthesis followed by the configured `accept` operation.

For bidirectional rules, supply a checking callback that uses its expected type before visiting children. A higher-rank theory's `enter` opens expected quantifiers before that callback runs. Do not replace subsumption with unification unless your theory gives them the same meaning.

## Add lexical bindings

Create a `Bindings` handle with `createBindings`. Supply your theory's `monomorphic`, `instantiate`, and `generalize` operations, plus the term constructors `parameter`, `declare`, and `reference`.

Use `bindings.reference(name, span)` at a use site. Use `bindings.parameter(name, type, span, body)` for a monomorphic parameter. Use `bindings.let(name, span, initializer, body)` for a nonrecursive binding. The initializer runs once, outside the new binding; the configured generalization policy determines its scheme.

Connect the optional `define` and `use` callbacks to your analysis collector. Binding identity remains separate from spelling and from each reference's instantiated type. For an IR language, bridge `declare` to the enclosing checked body's declaration collector.

The implementation in [`examples/hm/rank.ts`](../examples/hm/rank.ts) uses these helpers with `langkit/ir/check`. They keep source spans on the resulting IR, not only on checking diagnostics.
