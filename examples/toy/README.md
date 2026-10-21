# Toy

Toy is the smallest complete example in langkit: a compact, explicitly annotated expression language for seeing parsing, checking, typed IR construction, and JavaScript emission together without a separate compiler framework. Its implementation is intentionally concentrated in [`toy.ts`](./toy.ts), with the default program in [`main.toy`](./main.toy).

## Run it

From the repository root (Node.js 24.2+ and pnpm):

```sh
pnpm install
pnpm toy                         # runs examples/toy/main.toy
pnpm toy examples/toy/main.toy   # or pass another source path
pnpm toy:lsp                     # stdio language server
```

The default program computes `42` using a higher-order function and a closure:

```text
let twice = fn(f: number -> number) => fn(x: number) => f(f(x)) in
let inc = fn(x: number) => x + 1 in
let answer = twice(inc)(40) in
if answer > 40 then answer else 5
```

## Syntax and type model

Toy expressions are numbers, booleans, names, binary operations, `let`, functions, calls, and conditionals. A function has exactly one parameter, whose type is written after `:`; its result type is inferred. Types are `number`, `boolean`, and right-associative function arrows (`number -> boolean -> number` means `number -> (boolean -> number)`). Parentheses group types. Calls are unary and can chain: `f(1)(2)`.

`let name = value in body` is lexical and non-recursive. Functions close over surrounding bindings, and may accept or return functions. `if condition then yes else no` requires a boolean condition and equally typed branches; only the selected branch runs, although both branches are checked.

The checker uses structural type equality, not type inference or unification. It checks arithmetic operands as numbers, `>` as numeric comparison, and `==` for either two numbers or two booleans; functions cannot be compared. Arithmetic is `+`, `-`, `*`, `/`. Numbers follow JavaScript IEEE-754 behavior (including division by zero, `NaN`, and negative zero); overflowing literals are rejected. Numeric literals may be negative and decimal. General unary operators and exponent notation are not supported.

There is no recursion, polymorphism, record/data type, or mutable source-language state. This is an expression language rather than a statement language.

## Compile, analyze, and run

The compiler exports `compile(source)`, which returns either the compiled portable IR expression or diagnostics, and `analyze(source)`, which returns source analysis including expression types and editor facts. The checker is generator-based: `yield*` composes language-owned `Check` inference with IR declarations. Toy's types are immutable, so checking needs no solver state. `ir.body` collects the declarations, and `elaborateBody` is the reusable entry point.

Independent operand checks can recover and report multiple diagnostics with source spans. Recovery is limited to checks that can continue independently; it is not a claim that every error branch recovers. Diagnostics are plural, and a compilation with errors does not emit a target program. Import `program` for parsing and use `elaborateBody` for language-owned body elaboration. The language server in [`toy-lsp.ts`](./toy-lsp.ts) serves `analyze` over stdio; launch it with `pnpm toy:lsp` from the repository root.

The command-line runner reads a supplied file (defaulting to `main.toy`), compiles it, evaluates the emitted JavaScript expression, and displays the result. Emission returns an expression, not a complete JavaScript module; the runner provides its evaluation environment. The CLI uses the JavaScript backend, but the portable IR can be consumed by a selected backend: it is not JavaScript-specific and does not impose TypeScript's type ontology. The VM is for trusted demonstrations only, not a security sandbox for untrusted programs. The emitter does not produce source maps. The example has no optimization pass or LLVM backend, and there is no mandatory lowering pipeline.
