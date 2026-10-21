# Build a compiler with checks

Bring your own AST, semantic types, and term representation. Write the checker as one `switch` over the AST kind inside a `check` generator.

## Check your AST

This complete compiler accepts a numeric AST and emits JavaScript. The checker uses the supported solver rather than a local unifier.

```ts
import { type Check, check, run } from "langkit";
import * as rank from "langkit/types/higher-rank";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Expr =
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "add"; readonly left: Expr; readonly right: Expr; };

type Typed = { readonly type: rank.Type; readonly term: string; };

const elaborate = (node: Expr): Check<Typed> =>
  check(function*() {
    switch (node.kind) {
      case "number":
        return { type: rank.number, term: String(node.value) };
      case "add": {
        const left = yield* elaborate(node.left);
        const right = yield* elaborate(node.right);
        yield* rank.unify(left.type, rank.number);
        yield* rank.unify(right.type, rank.number);
        return { type: rank.number, term: `(${left.term}+${right.term})` };
      }
    }
  });

const outcome = run(elaborate({
  kind: "add",
  left: { kind: "number", value: 19 },
  right: { kind: "number", value: 23 },
}));
assert.ok(outcome.success);
assert.equal(rank.show(outcome.value.type), "number");
assert.equal(runInNewContext(outcome.value.term), 42);
```

TypeScript checks the `switch` for exhaustiveness. Each case sees only its own AST variant.

## Add lexical bindings

Keep the environment in `scoped(new Map())`. Enter a scope with `bind(env, entries, body)` and read it with `lookup(env, name)`. Store a scheme next to each binding so a use site can `instantiate` it.

For a nonrecursive `let`, check the initializer outside the new binding, call `generalize(type, outerSchemes)` with the schemes from `get(env)`, then bind the result. Bind a parameter with `mono(type)` so it stays monomorphic.

Report definitions and uses to an analysis collector with `facts.define` and `facts.reference`. For an IR language, declare the binding in the enclosing checked body with `langkit/ir/check`.

[`examples/hm/hm.ts`](../examples/hm/hm.ts) is a complete caller. It keeps source spans on the resulting IR, not only on checking diagnostics.
