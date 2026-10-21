# Hindley–Milner (HM)

HM is an expression language using Langkit's Hindley–Milner core of Langkit's higher-rank theory. It keeps Toy's expression syntax but removes parameter annotations. [`hm.ts`](./hm.ts) contains the language rules and compiler, and [`main.hm`](./main.hm) is its default program.

## Run it

From the repository root (Node.js 24.2+ and pnpm):

```sh
pnpm install
pnpm hm                         # runs examples/hm/main.hm
pnpm hm examples/hm/main.hm     # or pass another source path
pnpm hm:lsp                     # stdio language server
```

A small example uses one polymorphic identity at both boolean and numeric types:

```text
let id = fn(x) => x in
let twice = fn(f) => fn(x) => f(f(x)) in
if id(true) then twice(fn(x) => x + 1)(id(40)) else 0
```

## Syntax and type model

The expression forms and operators are the same as Toy: numeric and boolean literals, `let`, `fn`, unary-argument calls, `if`, arithmetic, numeric `>`, and numeric `==`. Functions are written `fn(x) => body` with no type annotation. Types are `number`, `boolean`, and function arrows. `let` is lexical and non-recursive; there is no recursion or mutable source-language state.

HM infers function and expression types with type variables, unification, generalization, and instantiation. A let-bound identity has type `a -> a`; each reference instantiates its generalized variables freshly, allowing `id(true)` and `id(40)` in one scope. Generalization includes only variables not free in the surrounding environment; function parameters stay monomorphic. Unification uses an occurs check and rejects infinite types such as the self-application `fn(x) => x(x)`.

Arithmetic, `>`, and `==` are numeric. Boolean equality is deliberately unsupported: plain HM does not provide the constraints needed to support equality on number/boolean while excluding functions. This language has no records, strings, recursion, polymorphic recursion, or mutable state.

## Compile, analyze, and run

[`hm.ts`](./hm.ts) exports `compile(source)` for parsing, inference, and compilation, and `analyze(source)` for source-oriented type and editor facts. Type checking and elaboration are generator-based: `yield*` composes language-owned `Check` inference computations with raw portable IR declarations. HM's solver allocations and constraints are run-local; journaled constraints and atomic checking allow a failed constraint operation to roll back its partial mutations. The optional elaboration adapter collects declarations, and reusable consumers use the language-owned `elaborateBody` rather than a foreign adapter wrapper.

Independent operand checks can recover multiple span-bearing diagnostics, but recovery is limited to checks that can safely continue; it does not imply every branch recovers. Diagnostics are plural, and compilation does not emit a target program when errors were recovered. Import `program` for parsing and `show` for the type printer. Import these APIs with a relative import such as `import { compile, analyze } from "./hm.ts"`.

The CLI runner accepts an optional source-file path and defaults to the example program. [`hm-lsp.ts`](./hm-lsp.ts) exposes analysis through the language server protocol; run it as a stdio server with `pnpm hm:lsp` at the repository root. HM is a single-file example language: it does not have source imports or a standard library. The CLI uses the JavaScript backend and evaluates emitted expressions in its demonstration runner, but the same portable IR can be consumed by another selected backend. The IR is not JavaScript-specific and does not impose TypeScript's type ontology. The runner is for trusted examples, not a security sandbox.
