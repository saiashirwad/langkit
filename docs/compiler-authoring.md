# Build a compiler with typed judgments

Bring your own AST, semantic types, and term representation. Use `createJudgments` to dispatch exhaustive synthesis and checking rules. Use `createCompiler` when you also want a source-to-outcome entrypoint with clean-only emission.

## Define rules for your AST

This complete compiler accepts a numeric AST and emits JavaScript. The rules use the supported HM solver rather than a local unifier.

```ts
import { createJudgments, type RuleTable } from "langkit/judgments";
import { createCompiler } from "langkit/language";
import { createTrace } from "langkit/trace";
import * as hm from "langkit/types/hm";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Expr =
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "add"; readonly left: Expr; readonly right: Expr; };

const compiler = createCompiler({
  configure: (source: Expr) => {
    const trace = createTrace<hm.Type, string, string, string>(hm.show, term => term);
    const rules: RuleTable<Expr, hm.Type, string> = {
      number: {
        mode: "synth",
        check: "fromSynth",
        *synth(node) {
          return { type: hm.number, term: String(node.value) };
        },
      },
      add: {
        mode: "synth",
        check: "fromSynth",
        *synth(node, judgments) {
          const left = yield* judgments.check(node.left, hm.number);
          const right = yield* judgments.check(node.right, hm.number);
          return { type: hm.number, term: `(${left}+${right})` };
        },
      },
    };
    const judgments = createJudgments(rules, {
      trace,
      modes: {
        enter: (expected, body) => body(expected),
        accept: (actual, expected) =>
          trace.constrain(
            "unify",
            [actual.type, expected],
            "numeric operand",
            hm.unify(actual.type, expected),
          ).map(() => actual.term),
      },
    });
    return {
      elaborate: judgments.synth(source),
      finalize: value => hm.generalize(value.type, []).map(() => value.term),
      snapshot: value => ({ type: hm.show(value.type), term: value.term }),
      facts: trace.snapshot(),
    };
  },
  emit: (term: string) => term,
});

const outcome = compiler.elaborate({
  kind: "add",
  left: { kind: "number", value: 19 },
  right: { kind: "number", value: 23 },
});
assert.equal(outcome.status, "checked");
if (outcome.status === "checked") {
  assert.equal(outcome.partial.type, "number");
  assert.equal(runInNewContext(compiler.emit(outcome.artifact)), 42);
  assert(outcome.facts.some(event => event.relation === "unify"));
}
```

Give each AST kind a rule. Use `mode: "checkingOnly"` for a form that requires an expected type. Use `mode: "unsupported"` with a reason for a deliberate rejection. Select `check: "fromSynth"` explicitly when checking means synthesis followed by the configured `accept` operation.

For bidirectional rules, supply a checking callback that uses its expected type before visiting children. A higher-rank theory's `enter` opens expected quantifiers before that callback runs. Do not replace subsumption with unification unless your theory gives them the same meaning.

## Add lexical bindings

Create a `Bindings` handle with `createBindings`. Supply your theory's `monomorphic`, `instantiate`, and `generalize` operations, plus the term constructors `parameter`, `declare`, and `reference`.

Use `bindings.reference(name, span)` at a use site. Use `bindings.parameter(name, type, span, body)` for a monomorphic parameter. Use `bindings.let(name, span, initializer, body)` for a nonrecursive binding. The initializer runs once, outside the new binding; the configured generalization policy determines its scheme.

Connect the optional `define` and `use` callbacks to your analysis collector. Binding identity remains separate from spelling and from each reference's instantiated type. For an IR language, bridge `declare` to the enclosing checked body's declaration collector.

The implementation in [`examples/hm/hm.ts`](../examples/hm/hm.ts) uses these helpers with `langkit/ir/check`. They keep source spans on the resulting IR, not only on checking diagnostics.

## Publish checked artifacts and editor facts

Allocate language handles in `configure` so each source elaboration has fresh configuration. Keep inference allocations and journaled mutations inside `Check` computations.

Supply a `snapshot` that detaches mutable semantic types from the partial result. Supply a `facts` computation that always completes, including after source errors. A failure in observation publication is an implementation error.

The finalizer owns your language's unresolved obligations and escape checks. Recovered diagnostics prevent finalization. Diagnostics produced during finalization prevent artifact publication. Only a `checked` outcome has an artifact accepted by `compiler.emit`; `recovered` retains the partial result, and `failed` retains facts without a partial result.

The artifact brand enforces this phase boundary. It does not make arbitrary compiler rules sound or freeze every nested value. Raw IR remains usable without a source-language checking proof.
