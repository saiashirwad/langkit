# Rows

Rows is an HM-inferred expression language that adds immutable records and strings, demonstrating structural row polymorphism and local source imports. It is separate from the smaller HM compiler; its implementation is in [`rows.ts`](./rows.ts), with a sample [`main.rows`](./main.rows) and source-written [`stdlib.rows`](./stdlib.rows).

## Run it

From the repository root (Node.js 24.2+ and pnpm):

```sh
pnpm install
pnpm rows                        # runs examples/rows/main.rows
pnpm rows examples/rows/main.rows
pnpm rows:lsp                    # stdio language server
```

This example imports helpers, selects a field, extends a record, and prints the computed value:

```text
import "./stdlib.rows";
let getX = fn(r) => r.x in
let extend = fn(r) => { flag = true | r } in
let answer = compose(getX)(extend)({ x = 42 }) in
let ignored = print("The answer is:") in
let ignored = print(answer) in
answer
```

Imports are local file imports resolved relative to the importing source. The shared loader (`examples/modules.ts`) reads modules without evaluating them, strips import directives while retaining source offsets, and detects invalid/cyclic module graphs. Nothing is imported implicitly; write an import explicitly.

## Syntax and type model

Rows retains HM's non-recursive `let`, inferred one-argument functions (`fn(x) => body`), unary calls, conditionals, numeric arithmetic/comparison/equality, and adds booleans, strings, and records. Strings use double quotes with JSON escapes. Calls and field selection chain, for example `record.f(42).answer`.

`{ x = 1, flag = true }` constructs a closed record; `{}` is the empty record. `{ flag = true | record }` extends a record. Extension is not overwrite: the new label must be absent from the base record. Its fields are evaluated left-to-right, followed by the base, each exactly once.

Types include ordinary HM type variables and row variables. A row variable represents the still-unknown remainder of a record, with explicit lacks constraints. For example `getX` infers a function requiring an `x` field and returning its value; `extend` preserves the input row while adding a boolean `flag` field, with the constraint that `flag` was absent. Both ordinary and row variables generalize at `let`; captured variables and function parameters are monomorphic. Row unification rejects missing or duplicate fields and infinite rows/types; field order does not affect type equality. The type printer displays field-absence constraints.

This remains a pure expression language: there is no statement syntax or effect system. `print` is an intrinsic with type `a -> {}`: it prints one value and returns the empty record. Sequence it with `let ignored = print(value) in ...`. The source-defined `id`, `const`, and `compose` are ordinary polymorphic functions, not special typing rules. `const(x)(y)` keeps `x`, but both calls still evaluate their arguments. These names may be shadowed.

| Name | Type | Behavior |
| --- | --- | --- |
| `print` | `a -> {}` | Prints one value and returns the empty record. |
| `id` | `a -> a` | Returns its argument. |
| `const` | `a -> b -> a` | Keeps the first argument; both arguments are evaluated. |
| `compose` | `(b -> c) -> (a -> b) -> a -> c` | `compose(f)(g)(x)` computes `f(g(x))`. |

## Compile, analyze, and run

[`rows.ts`](./rows.ts) exports `compile(source, options?)` to load imported source, parse it, infer/check types, and compile; `analyze(source, options?)` returns source analysis and editor facts without executing or printing the program. `program` is the parser, `elaborate` checks a parsed expression, and `show` prints inferred types. The optional module options let an embedder provide the root URI and source reader. Import the APIs from `./rows.ts`.

The CLI runner uses `console.log` and also displays the final program value. If evaluating emitted JavaScript yourself, supply a `console.log` implementation. The runtime primitive's uses can receive type hovers, but have no same-file definition location; imported library source spans are not returned as user-source facts. The VM runner is for trusted examples, not untrusted code.