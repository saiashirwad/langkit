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

Imports are local file imports resolved relative to the importing source. The [module loader](../../docs/module-loading.md) reads modules without evaluating them, masks import directives while retaining source offsets, and rejects invalid or cyclic graphs. Rows explicitly selects the optional prefix import parser. Nothing is imported implicitly.

## Syntax and type model

Rows retains HM's non-recursive `let`, inferred one-argument functions (`fn(x) => body`), unary calls, conditionals, numeric arithmetic/comparison/equality, and adds booleans, strings, and records. Strings use double quotes with JSON escapes. Calls and field selection chain, for example `record.f(42).answer`.

`{ x = 1, flag = true }` constructs a closed record; `{}` is the empty record. `{ flag = true | record }` extends a record. Extension is not overwrite: the new label must be absent from the base record. Its fields are evaluated left-to-right, followed by the base, each exactly once.

The reusable [row theory](../../docs/inference-theories.md) provides ordinary HM variables and row variables. A row variable represents the unknown remainder of a record and carries label-absence constraints. `getX` requires an `x` field and returns its value. `extend` preserves the input row and adds a Boolean `flag`, provided that label was absent. Both ordinary and row variables generalize at `let`; captured variables and parameters remain monomorphic. Unification rejects missing or duplicate fields and infinite types or rows. Field order does not affect type equality.

This remains a pure expression language: there is no statement syntax or effect system. `print` is an intrinsic with type `a -> {}`: it prints one value and returns the empty record. Sequence it with `let ignored = print(value) in ...`. The source-defined `id`, `const`, and `compose` are ordinary polymorphic functions, not special typing rules. `const(x)(y)` keeps `x`, but both calls still evaluate their arguments. These names may be shadowed.

| Name      | Type                             | Behavior                                                |
| --------- | -------------------------------- | ------------------------------------------------------- |
| `print`   | `a -> {}`                        | Prints one value and returns the empty record.          |
| `id`      | `a -> a`                         | Returns its argument.                                   |
| `const`   | `a -> b -> a`                    | Keeps the first argument; both arguments are evaluated. |
| `compose` | `(b -> c) -> (a -> b) -> a -> c` | `compose(f)(g)(x)` computes `f(g(x))`.                  |

## Compile, analyze, and run

[`rows.ts`](./rows.ts) exports `compile(source, options?)` to load imported source, parse it, infer/check types, and compile; `analyze(source, options?)` returns source analysis and editor facts without executing or printing the program. Its generator-based checker composes language-owned `Check` inference with raw portable IR declarations using `yield*`. Solver allocations and constraints are run-local; journaled constraint updates and atomic checking can roll back partial mutations on failure. The optional elaboration adapter collects declarations, while reusable consumers use Rows' language-owned `elaborateBody` without a foreign adapter wrapper.

Independent operand checks can recover multiple diagnostics with source spans. Recovery is limited to checks that can safely continue; it does not claim every branch recovers. Diagnostics are plural, and the compiler does not emit a target program when errors are present. Import `program` for parsing and `show` for inferred types. The optional module options let an embedder provide the root URI and source reader.

The CLI runner uses `console.log` and also displays the final program value. If evaluating emitted JavaScript yourself, supply a `console.log` implementation. The CLI uses the JavaScript backend, but the portable IR can be consumed by another selected backend; it is not JavaScript-specific and does not impose TypeScript's type ontology. The runtime primitive's uses can receive type hovers, but have no same-file definition location; imported library source spans are not returned as user-source facts. The VM runner is for trusted examples, not untrusted code.
