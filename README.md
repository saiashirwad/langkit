# langkit

A small experiment in writing a language's syntax, typing rules, and translation together in TypeScript.

There is no `defineLanguage` object. Parsing returns your tree. Checking can construct typed IR directly. A target emits that IR. Each piece is independently usable.

## Start here

Requires Node 24.2+ (the example uses `import.meta.main`) and pnpm.

```sh
pnpm install
pnpm toy examples/toy/main.toy
# Or: pnpm toy path-to-file.tpy
pnpm typecheck
pnpm test
```

Each language has its own folder under `examples/`: `toy/`, `hm/`, `rows/`, `advanced/`, and `strict/`. Its compiler, language server, sample, and any syntax/types/stdlib files live together. The shared import loader stays at `examples/modules.ts`.

The whole toy language is in **[examples/toy/toy.ts](examples/toy/toy.ts)**, in reading order:

1. Its types and syntax tree.
2. Its parser.
3. Its checking rules, which construct IR values.
4. Its ordinary `compile(source)` function.
5. A source analysis entry point and a runner that evaluates the emitted JavaScript.

The runner reads [examples/toy/main.toy](examples/toy/main.toy) by default; pass another file path to run a different program. The default program uses higher-order functions and closures to compute `42`:

```text
let twice = fn(f: number -> number) => fn(x: number) => f(f(x)) in
let inc = fn(x: number) => x + 1 in
let answer = twice(inc)(40) in
if answer > 40 then answer else 0
```

## The pieces

| Module | Responsibility |
| --- | --- |
| `langkit/parse` | Parserator's parsers, generators, precedence, cuts, and locations. |
| `langkit` | Synchronous checking, scoped values, name lookup, and diagnostics. |
| `langkit/ir` | Typed values, binding identities, body construction, and scope validation. |
| `langkit/javascript` | Emit the small IR as a JavaScript expression. |
| `langkit/analysis` | Optionally collect typed source ranges, declarations, references, and tokens. |
| `langkit/lsp` | Expose that analysis through the Language Server Protocol. |

Parsing delegates to the published `parserator@0.3.0`, rather than introducing another parser implementation. Its API currently differs slightly from the neighboring parserator working tree. There are no local-path dependencies, and no Effect dependency.

### Checking and construction cooperate

The example supplies its own `Type` union:

```ts
const code = create<Type>()
const env = scoped<ReadonlyMap<string, Binding<Type>>>(new Map())
```

An addition rule checks its operands and returns an IR value carrying that language's result type:

```ts
const left = yield* elaborate(expr.left)
const right = yield* elaborate(expr.right)
yield* expect(left, number)
yield* expect(right, number)
return code.binary(number, "+", left, right)
```

A `Check<A>` can be combined with `yield*`, `map`, or `flatMap`. Expected source errors use `fail`; implementation exceptions propagate. Checks stop at the first error. They do not provide recovery, backtracking, or transactional mutation.

IR construction uses those same checks, not a second generator runner:

```ts
const body = code.body(check(function* () {
  const x = yield* code.declare("x", code.literal(number, 20))
  return code.binary(number, "+", x, code.literal(number, 22))
}))
```

`code.body` captures declarations and the final value. `Body<T>` is the resulting data, **not** a generator function. A declaration returns a reference with its own binding identity; its name is only a hint for emission.

`code.scope` makes a captured body into an expression. The example uses it for `let`, keeping declarations inside their original expressions. Function and conditional bodies are captured separately. This preserves evaluation order and prevents declarations from being hoisted out of branches. The first JS emitter deliberately uses IIFEs rather than attempting scope-flattening optimizations.

### What "typed IR" means here

`Value<T>` carries a runtime type descriptor from the language's own type universe. The core does not know whether that universe uses numbers, rows, effects, or something else. The toy checker implements structural type equality; it is not a unification engine.

This is **not a static proof that arbitrary IR is well typed**. Low-level constructors trust the language's typing rules: it is possible to label a literal incorrectly or build an invalid call by bypassing those rules. TypeScript checks the type universe and the implementation's data shapes; the toy checker checks source programs at runtime. A later transformation that changes operand types must preserve or recheck those invariants.

Before emitting, structural validation checks references, declaration order, and unique binding identities. Emission chooses safe, unique names. Source spans remain on elaborated IR values, but this emitter does not produce source maps.

## The toy language

- Numbers use JavaScript's IEEE-754 semantics, including division by zero, `NaN`, and negative zero. Overflowing number literals are rejected.
- Arithmetic: `+`, `-`, `*`, `/`. Comparison: `>`. Equality: `==` between numbers or between booleans; functions cannot be compared.
- `let name = value in body` is lexical and non-recursive.
- `fn(name: type) => body` has one annotated parameter and an inferred result type. Functions may capture bindings, accept functions, and return functions.
- Types are `number`, `boolean`, and right-associative `a -> b`; parentheses group types.
- Calls use `f(value)` and may chain, as in `add(1)(2)`.
- `if condition then a else b` requires a boolean condition and equal branch types. Only the selected branch executes, though both are checked.
- Number literals may have a leading minus and a decimal part. General unary operators and exponent notation are not implemented.

The toy language has no recursion, polymorphism, or records. There are no optimization passes or LLVM backend yet. The toy and HM examples remain single-file languages. The mid-level representation is the small, inspectable expression IR in `src/ir.ts`; there is no separate mandatory lowering pipeline. Pure transformations can be ordinary functions between checking and emission.

`emit(body)` returns a JavaScript **expression**, not a complete module. The example evaluates trusted demonstrations using `node:vm`; that is not a security sandbox for untrusted code.

## Hindley–Milner inference

**[examples/hm/hm.ts](examples/hm/hm.ts)** is a second, self-contained language compiler. It keeps toy's expression syntax, but writes functions as `fn(x) => body` without annotations:

```text
let id = fn(x) => x in
let twice = fn(f) => fn(x) => f(f(x)) in
if id(true) then twice(fn(x) => x + 1)(id(40)) else 0
```

```sh
pnpm hm examples/hm/main.hm
# Or: pnpm hm path-to-file
```

`id` has the generic type `a -> a`. Each use gets fresh type variables, so the same binding accepts a boolean and a number. `let` generalizes only variables not free in the surrounding environment; function parameters remain monomorphic. Unification includes an occurs check, rejecting infinite types such as `fn(x) => x(x)`.

Inference belongs to this example, not the library: type variables, unification, generalization, and instantiation are ordinary functions cooperating with `Check`. The original toy compiler still uses explicit parameter annotations and structural type equality. Neither language has recursion or mutable source-language state.

HM's arithmetic, `>`, and `==` operate on numbers. Unlike toy, HM does not support boolean equality: excluding functions from generic equality would require constraints beyond plain Hindley–Milner inference.

The shared IR supports `code.ref(binding, instantiatedType)`. This keeps declaration identity while allowing a different type at each use; omitting the second argument preserves the original behavior. Editor reference facts likewise track identity only. Both compilers report expression types separately, so a generic declaration's hover does not mask a specialized use's type.

## Row polymorphism

**[examples/rows/rows.ts](examples/rows/rows.ts)** is a separate HM language with immutable records, strings, and a tiny standard library. The existing HM example is unchanged.

```sh
pnpm rows                 # runs examples/rows/main.rows
pnpm rows path/to/program.rows
```

```text
import "./stdlib.rows";
let getX = fn(r) => r.x in
let extend = fn(r) => { flag = true | r } in
let answer = compose(getX)(extend)({ x = 42 }) in
let ignored = print("The answer is:") in
let ignored = print(answer) in
answer
```

- `{ x = 1, flag = true }` constructs a closed record; `{}` is the empty record.
- `record.x` selects a field. Selection and calls chain: `record.f(42).answer`.
- `{ flag = true | record }` extends a record, requiring `flag` to be absent. It does not overwrite fields. Fields evaluate left to right, followed by the base, each exactly once.
- Strings use double quotes and JSON escapes. Arithmetic and equality remain numeric.

`getX` infers `({ x: a | r } -> a) where r lacks x`. The row variable `r` stands for the remaining fields, not an unchecked bag of extra properties. `extend` infers `({ | r } -> { flag: boolean | r }) where r lacks flag`. Absence constraints survive aliases, generalization, and instantiation. Record field order does not affect type equality.

Both ordinary type variables and row variables are let-polymorphic; captured variables and function parameters remain monomorphic. Unification rejects missing fields, duplicates, and infinite types/rows. The type printer includes field-absence constraints explicitly. These rules live entirely in the example, not the shared IR.

### Small standard library

Import `"./stdlib.rows"` to bring `id`, `const`, and `compose` into scope. `print` is a runtime primitive. These names can be shadowed:

| Name | Type | Behavior |
| --- | --- | --- |
| `print` | `a -> {}` | Prints one value and returns the empty record. |
| `id` | `a -> a` | Returns its argument. |
| `const` | `a -> b -> a` | Keeps the first argument. Both calls still evaluate their arguments. |
| `compose` | `(b -> c) -> (a -> b) -> a -> c` | `compose(f)(g)(x)` computes `f(g(x))`. |

[id, const, and compose](examples/rows/stdlib.rows) are ordinary source-language functions, not special typing rules. `print` is the only intrinsic. Sequence printing with `let ignored = print(value) in ...`; there is no statement syntax or effect-type system. Functions are still written as `fn(x) => body`, and `let` is non-recursive.

The runner uses `console.log` and also displays the program's final value. When evaluating emitted JavaScript yourself, provide a `console.log` implementation. Analysis never executes the program or prints. Built-in uses have type hovers but no same-file definition location; library source spans are not reported as user-source facts. As with the other examples, the VM runner is for trusted demonstrations, not a security sandbox.

## Higher-rank polymorphism and data types

**[examples/advanced/advanced.ts](examples/advanced/advanced.ts)** adds nominal algebraic data types, exhaustive pattern matching, recursive functions, and explicitly annotated higher-rank polymorphism, while keeping row-polymorphic records and HM let-inference.

```sh
pnpm advanced                         # runs examples/advanced/main.advanced
pnpm advanced path/to/program.advanced
```

This example is split by responsibility rather than growing a single file:

- [advanced-syntax.ts](examples/advanced/advanced-syntax.ts): syntax trees, parsers, and lexical highlighting.
- [advanced-types.ts](examples/advanced/advanced-types.ts): types, rows, unification, generalization, rigid variables, and subsumption.
- [advanced.ts](examples/advanced/advanced.ts): bidirectional checking, datatype declarations, IR construction, analysis, and the runner.
- [stdlib.advanced](examples/advanced/stdlib.advanced): ordinary source-language datatypes and functions.

### Data types and matching

Datatype declarations come before the main expression. They may refer to themselves or other types declared in the same file. Types are **nominal**: two separately named types are distinct even if their constructors have the same shape.

```text
type Tree(a) = Leaf(a) | Branch(Tree(a), Tree(a))

let rec sum = fn(tree) => match tree {
  Leaf(value) => value,
  Branch(left, right) => sum(left) + sum(right)
} in
sum(Branch(Leaf(20), Leaf(22)))
```

Constructors are ordinary curried values: `Branch(left, right)` is shorthand for `Branch(left)(right)`. A nullary constructor such as `None` or `Nil` is a value, not a zero-argument call. Match payloads bind variables or `_`; use another `match` for nested destructuring. A lowercase variable or `_` can catch the whole remaining value.

The checker rejects missing constructors, duplicate cases, cases after a catch-all, wrong constructor arities, mixed datatype families, and repeated pattern bindings. Branches must agree on their result type. Matching evaluates the scrutinee once and executes only the selected branch.

### Checking more than HM can infer

An unannotated function parameter is still monomorphic. An explicit `forall` lets the caller supply a genuinely polymorphic function:

```text
let use = fn(f: forall a. a -> a) =>
  if f(true) then f(42) else 0
in
use(id)
```

Unlike ordinary HM inference, `f` is used at both `boolean` and `number` inside the same function. `use(fn(x) => x)` also checks; `use(fn(x) => x + 1)` does not.

Annotations can appear on let bindings, function parameters, or parenthesized expressions:

```text
let identity: forall a. a -> a = fn(x) => x in
let use: (forall a. a -> a) -> number = fn(f) => f(42) in
use(identity)
```

Types include `number`, `boolean`, `string`, named applications such as `List(number)`, closed records such as `{ value: number }`, right-associative arrows, and `forall a b. ...`. Quantifiers may nest under arrows; annotated higher-rank results and higher-rank arguments are supported. `forall` names are scoped to their type annotation, not subsequent source annotations.

Checking a `forall` introduces fresh **rigid** types rather than choosing a convenient instance. Scope levels on ordinary and row inference variables prevent those rigid types escaping through captured values. For ordinary expressions, the checker still infers types and generalizes only variables not free in the environment. There is no automatic inference of polymorphic lambda parameters.

`let rec` accepts only a direct function initializer. Without an annotation, recursive uses share one monomorphic type and the completed binding can then generalize. A complete `forall` annotation permits checked polymorphic recursion. Recursive evaluation uses JavaScript calls: termination is not checked and there is no tail-call optimization.

### Standard library and limits

Add `import "./stdlib.advanced";` to use `Option(a)` (`None`, `Some`), `Result(a, e)` (`Ok`, `Err`), and `List(a)` (`Nil`, `Cons`), or helpers such as `id` in the snippets above. Nothing from the stdlib is loaded implicitly. Imported datatype names cannot be redeclared in the importing file. Alongside `print`, `id`, `const`, and `compose`, the source-written library provides:

| Helper | Calling convention |
| --- | --- |
| `mapOption`, `mapResult` | `mapOption(f)(option)`, `mapResult(f)(result)` |
| `withDefault` | `withDefault(fallback)(option)` |
| `andThen` | `andThen(f)(result)`; `f` returns another `Result` |
| `mapList` | `mapList(f)(list)` |
| `foldList` | `foldList(step)(initial)(list)`; `step(accumulator)(element)`, left to right |
| `head` | `head(list)` returns an `Option` |
| `length`, `append` | `length(list)`, `append(left)(right)` |
| `range` | `range(start)(end)`, inclusive, increments by one |

`print` remains the only intrinsic and returns `{}`. The runner prints the final result too. `//` comments and multiple call arguments are new syntax; all row-language record operations remain available.

This is an explicitly annotated, predicative higher-rank example—not impredicative System F inference. Direct `forall` record fields, constructor payloads, and datatype arguments are intentionally unsupported. Record annotations are closed; open row types are inferred, not explicitly quantified in annotations. Patterns are flat constructor patterns or catch-alls, without guards or literal patterns. There are no type classes, subtyping, mutable references, effect tracking, or mutually recursive term bindings. Numeric operations retain JavaScript semantics; use finite, practical ranges and lists. The VM runner remains a trusted-example runner, not an untrusted-code sandbox.

## A strict, PureScript-like language

**[examples/strict/strict.ts](examples/strict/strict.ts)** adds higher-kinded types, single-parameter type classes, inferred constraints, dictionary-passing compilation, and explicit effects. It is a mini language inspired by PureScript, not a compatible implementation of Haskell or PureScript. Ordinary evaluation is **strict**, not lazy.

```sh
pnpm strict                      # runs examples/strict/main.strict
pnpm strict path/to/program.strict
```

The surface syntax uses whitespace application, lambdas, top-level signatures/definitions, and explicit delimiters rather than indentation:

```text
import "./stdlib.strict";

keep : forall f a. Functor f => f a -> f a;
keep xs = map id xs;

main : Effect {};
main = do {
  print (keep (Some 42));
  print (keep (Cons true Nil));
  pure {};
};
```

- `f x y` applies curried functions; lambdas are `\x y -> body`.
- `data Tree a = Leaf a | Branch (Tree a) (Tree a);` declares a datatype. Applied constructor-field types need parentheses.
- `case tree of { Leaf x -> x; Branch left right -> ...; }` uses the same exhaustive, flat constructor matching as advanced.
- Top-level definitions/signatures end in `;`. Classes, instances, cases, and `do` blocks use braces. `--` and `//` introduce line comments.
- Recursion is explicit: `rec factorial n = if n == 0 then 1 else n * factorial (n - 1);`. Local bindings retain `let [rec] name = value in body`.
- Row-polymorphic records, closed record annotations, strings, numeric arithmetic/comparison, and explicitly annotated higher-rank functions remain available. For example, `\(f : forall a. a -> a) -> if f true then f 42 else 0`.
- A module evaluates its `main`, or an optional trailing expression. Definitions are sequential; datatype names are registered together to allow recursive types.

### Kinds, classes, and dictionaries

Kinds distinguish a value type such as `number : Type` from a type constructor such as `List : Type -> Type`. Type applications such as `f a` participate in unification: mapping over `Some 42` determines `f = Option`. Ill-kinded applications and infinite kinds are rejected. Datatype parameter kinds are inferred from fields; unconstrained kinds default to `Type`. There is no kind polymorphism.

The [source standard library](examples/strict/stdlib.strict) defines:

```text
class Functor (f : Type -> Type) where {
  map : forall a b. (a -> b) -> f a -> f b;
}
```

It supplies separate instances for `Option` and `List`. You can define your own classes and instances:

```text
class Select a where { select : a -> a; }
instance Select number where { select x = x + 1; }
instance Select boolean where { select x = x; }

choose x = select x;
main = if choose true then choose 41 else 0;
```

`choose` infers a `Select a` constraint; each call receives the appropriate instance dictionary. A class parameter defaults to kind `Type`; specify its kind for higher-kinded classes. Constraints can also appear explicitly after `forall`, including multiple constraints: `forall a. (Select a, Other a) => a -> a`.

Compilation elaborates methods into dictionary projections and constrained functions into functions with extra dictionary arguments. Dictionaries are ordinary records in the existing IR. Resolution does not guess an instance to fill an unknown type, and there is no numeric/default-instance defaulting. Duplicate instances, missing/extra instance methods, ambiguous constraints, missing instances, and incompatible method implementations are errors.

This first version intentionally restricts instance heads to **closed nominal types/constructors or primitives**. There are no instance contexts such as `Eq a => Eq (List a)`, superclass constraints, overlapping instances, deriving, associated types, or multiparameter classes. Instances are checked in source order, before that module's value definitions; their methods may use the prelude/earlier module bindings or local helpers, but not later dictionaries or same-module top-level helpers. Recursive instance helpers should be local recursive functions.

Inferred constrained bindings must be functions or aliases. Write `bump xs = map (\x -> x + 1) xs`, rather than an overloaded computed value `bump = map (\x -> x + 1)`. This keeps strict initialization explicit. Recursive overloaded functions need a complete constrained signature. Constraints under arrows and constrained higher-rank parameters are not supported; unconstrained higher-rank parameters still are. Compilation requires the selected entry's constraints to be resolved.

### Strict values, explicit effects

`Effect a` is opaque to source programs. Runtime primitives are available without an import:

| Name | Type |
| --- | --- |
| `print` | `forall a. a -> Effect {}` |
| `pureEffect` | `forall a. a -> Effect a` |
| `bindEffect` | `forall a b. Effect a -> (a -> Effect b) -> Effect b` |

The stdlib defines `Monad`, `pure`, and `bind` in source, with `Option` and `Effect` instances:

```text
class Monad (m : Type -> Type) where {
  pure : forall a. a -> m a;
  bind : forall a b. m a -> (a -> m b) -> m b;
}
```

`do` uses the selected `Monad` dictionary, sharing the same constructor across every step. `Option` stops at `None`; `Effect` sequences delayed actions. Local bindings named `bind` do not change the meaning of `do`.

```text
import "./stdlib.strict";

answer : Option number;
answer = do {
  x <- Some 20;
  y <- Some 22;
  pure (x + y);
};

main : Effect {};
main = do {
  print answer;
  pure {};
};
```

The final statement must be a monadic action, and different monads cannot be mixed in one block. Generic helpers infer a `Monad m` constraint. `pure 42` alone is ambiguous: context or a signature must choose the monad; it no longer defaults to `Effect`. The compiler checks instance method types, not the monad laws.

Constructing `print 42` does not print. Pure arithmetic cannot consume an effect action, records cannot impersonate `Effect`, and source code cannot call an action as a function or run one inside pure code. Ordinary evaluation stays strict; only explicit effects are delayed. There are no effect rows.

The runtime represents actions as functions taking an empty record. **`compile(source).value.javascript` constructs the source result; it does not run an action.** The CLI executes an effect entry once under the VM timeout, without printing its returned value again. A pure entry is evaluated and displayed. Actions are repeatable, not memoized: sequencing the same action twice executes it twice. Analysis neither evaluates source code nor executes actions.

The standard library also includes the advanced example's `Option`, `Result`, list operations, and function helpers, rewritten in the new syntax. The implementation remains split into [syntax](examples/strict/strict-syntax.ts), [types/kinds](examples/strict/strict-types.ts), and [elaboration](examples/strict/strict.ts). The shared IR needs no new type-class or effect-specific nodes. There are still no FFI, asynchronous effects, mutable references, tail-call optimization, or untrusted-code sandbox. [main.strict](examples/strict/main.strict) is a longer, runnable tour of records, `Functor`, recursive trees, higher-rank functions, `Option` short-circuiting, generic monadic helpers, and printing.

## Explicit imports

The rows, advanced, and strict languages **never load their stdlib automatically**. Add an import yourself:

```text
import "./stdlib.strict";
```

Use `.rows` or `.advanced` for those languages. Paths must start with `./` or `../`, resolve relative to the importing file, and stay in the same language. There is no package lookup or network fetching. Cycles, unreadable files, and conflicting imported names are diagnostics. Each dependency is checked and emitted once; diamond imports share identities instead of redefining names. A module only sees its own imports, not unrelated sibling dependencies.

- **Strict:** top-level values, datatypes/constructors, classes, and instances are exported. A library does not need `main`.
- **Rows/advanced:** an imported module's final expression must be a record; its fields are the exported values. Advanced also exports datatypes and constructors.
- Imports bring names directly into scope, without namespaces. Imported names are re-exported transitively; local value definitions may shadow imports. There are no explicit export lists or qualified names yet.
- Standard libraries are ordinary modules. Opening one in the editor analyzes that file directly, rather than injecting another copy of itself.

`compile(source, { uri })` and `analyze(source, { uri })` use a file URI as the import base. Without it, the base is `input.<language>` in the working directory. An optional `read(uri)` callback supplies dependency text, useful for virtual files and unsaved editor buffers. The CLI supplies the actual input file URI. Imports do not execute code during checking or analysis; emitted programs evaluate module definitions, but imported `Effect` values are not automatically run.

## Editor support

All five languages have small stdio LSP servers:

```sh
node examples/toy/toy-lsp.ts --stdio
node examples/hm/hm-lsp.ts --stdio
node examples/rows/rows-lsp.ts --stdio
node examples/advanced/advanced-lsp.ts --stdio
node examples/strict/strict-lsp.ts --stdio
# Also available as pnpm <language>:lsp; use direct node commands in editors.
```

It provides syntax/type diagnostics, type hover, go-to-definition, and semantic highlighting. Rows, advanced, and strict support definitions in imported files and recheck open importers when an imported buffer changes or closes. It only analyzes text; it never emits or executes a program. The server uses the standard `vscode-languageserver` packages, imported only through `langkit/lsp`.

The language adapter is just:

```ts
import { serve } from "langkit/lsp"
import { analyze, show } from "./toy.ts"

serve(analyze, show)
```

### What the language author supplies

Keep precise source spans for names, reuse lexical patterns for tolerant highlighting, and report meaningful checking events:

```ts
const facts = createAnalysis<Type>()

yield* facts.define(binding, declarationSpan, "function")
yield* facts.reference(binding, referenceSpan)
yield* facts.typed(value.type, expressionSpan)
```

`reference` records only the binding identity and source span; call `typed` with the actual expression type to supply hover information.

These operations retain nothing during ordinary compilation. `facts.collect(checker, tokens)` runs a check with observation enabled, returning its result and an `Analysis<Type>`. Completed facts survive a later checking failure. Binding identities distinguish shadowed names and captured references. `show` remains language-specific; analysis carries the actual language types, not preformatted hover strings.

`highlight(source, rules)` applies ordered lexical rules and skips unknown characters. The example shares identifier/number patterns and keyword vocabulary with its parser. Successful checking refines identifier tokens into function and parameter roles. Highlighting does not require the parser to accept the whole file.

This is deliberately an explicit, small integration, not automatic extraction of arbitrary parser code into a grammar.

### Neovim 0.11+

[.nvim.lua](.nvim.lua) configures all five servers and recognizes `.toy` / `.tpy` files as toy, `.hm` files as HM, `.rows` files as rows, `.advanced` files as advanced, and `.strict` files as strict, only inside this checkout. Enable trusted project-local configuration in your Neovim settings:

```lua
vim.opt.exrc = true
```

Start Neovim from the project directory:

```sh
cd ~/code/langkit
nvim examples/toy/main.toy
# Or: nvim examples/hm/main.hm
```

Review and trust `.nvim.lua` when prompted. Neovim records trust for that file's contents; changes require approval again. Enabling `exrc` does not silently trust other projects. On Neovim 0.12, starting in a subdirectory also discovers the parent config.

Use `K` to hover over `twice`, or `vim.lsp.buf.definition()` on `inc` in `twice(inc)(40)` (your configured `gd` mapping can call it). Semantic colors depend on your editor/theme. If an existing session did not load the local config, restart from the project directory. The `.nvim.lua` file restricts filetype detection and server attachment to this project.

### Current limits

Analysis is synchronous and recomputed on document changes; there is no incremental compiler. Source positions use UTF-16, matching parserator and the negotiated LSP encoding. Diagnostics carry document versions, and closing a document discards its analysis.

The parser still stops at its first syntax error. Incomplete syntax gets lexical highlighting and a diagnostic, but no hover/definitions. For syntactically complete programs, facts collected before a type error remain available. There is no parser recovery, completion, rename, TextMate grammar, or Tree-sitter grammar yet. Import resolution is limited to explicit local file imports in rows, advanced, and strict.

## Tests

Runtime tests cover parsing, precedence, diagnostics, functions, closure capture, shadowing, branch isolation, construction reuse, scope validation, and evaluation order. Analysis tests cover precise name ranges, shadowing, partial checking results, and malformed-input highlighting. LSP tests communicate with a real server over framed JSON-RPC. `tests/types.ts` supplies compile-time contracts checked by `pnpm typecheck`.
