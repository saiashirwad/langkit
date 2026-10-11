# Advanced: higher-rank polymorphism and data types

Advanced builds on HM and Rows with nominal algebraic data types, pattern matching, recursive functions, and annotated higher-rank polymorphism. It demonstrates bidirectional checking, not a production language. [`advanced-syntax.ts`](./advanced-syntax.ts) owns parsing. [`langkit/types/higher-rank`](../../src/types/higher-rank.ts) owns the reusable level-based solver. [`advanced.ts`](./advanced.ts) owns language rules, analysis, compilation, and execution. [`stdlib.advanced`](./stdlib.advanced) defines source datatypes and functions.

## Run it

From the repository root (Node.js 24.2+ and pnpm):

```sh
pnpm install
pnpm advanced                      # runs examples/advanced/main.advanced
pnpm advanced examples/advanced/main.advanced
pnpm advanced:lsp                  # stdio language server
```

A minimal recursive datatype example:

```text
type Tree(a) = Leaf(a) | Branch(Tree(a), Tree(a))

let rec sum = fn(tree) => match tree {
  Leaf(value) => value,
  Branch(left, right) => sum(left) + sum(right)
} in
sum(Branch(Leaf(20), Leaf(22)))
```

## Data types and matching

Datatype declarations appear before the main expression and may refer to themselves or other types declared in the same file. Datatypes are nominal: separately named types are distinct even if their constructors have identical shapes. Constructor values are curried; `Branch(left, right)` is shorthand for `Branch(left)(right)`. Nullary constructors such as `None` and `Nil` are values, not zero-argument calls.

Patterns are flat constructor patterns or catch-alls. Constructor payload positions bind variables or `_`; nested destructuring uses another `match`. A lowercase binding or `_` can catch the whole remaining value. Matches must account for every constructor, cannot repeat cases or place cases after a catch-all, and cannot mix datatype families. Constructor arity and repeated pattern bindings are checked; all branches must have the same result type. Evaluation evaluates the scrutinee once and executes only the selected branch.

Expressions retain Rows' records, field selection, strings, and row inference, as well as HM-style let inference and numeric/boolean expressions. Types also include named datatype applications such as `List(number)`. Record field selection and row constraints behave as in [Rows](../rows/README.md).

## Explicit polymorphism and recursion

An unannotated lambda parameter remains monomorphic. To pass a function that is used polymorphically inside another function, annotate its parameter with `forall`:

```text
let use = fn(f: forall a. a -> a) =>
  if f(true) then f(42) else 0
in
use(id)
```

The checker requires `f` to work at both types in the same function; `use(fn(x) => x)` checks, while `use(fn(x) => x + 1)` does not. Annotations may be placed on let bindings, function parameters, or parenthesized expressions. Types include `number`, `boolean`, `string`, named type applications, closed record types, right-associative arrows, and `forall a b. ...`; quantifiers may nest under arrows, so higher-rank arguments and results can be annotated. Names bound by `forall` are scoped to that annotation.

Checking a `forall` introduces rigid type variables rather than choosing a convenient instance; scope levels prevent those rigid types escaping through captured values. Ordinary expressions still infer types and generalize variables not free in the environment. The language does not infer polymorphic lambda parameters automatically.

`let rec` accepts only a direct function initializer. Unannotated recursive uses share one monomorphic type, after which the completed binding can generalize. A complete `forall` annotation enables checked polymorphic recursion. Recursive calls use JavaScript calls: termination is not checked and there is no tail-call optimization. Term bindings are not mutually recursive.

## Imports and standard library

Nothing is loaded implicitly. Add `import "./stdlib.advanced";` to use the standard datatypes `Option(a)` (`None`, `Some`), `Result(a, e)` (`Ok`, `Err`), and `List(a)` (`Nil`, `Cons`), along with `id`, `const`, and `compose`. Imported datatype names cannot be redeclared in the importing file. The shared import loader handles local source files; imports are source dependencies, not runtime module execution.

The library also defines these ordinary source-language helpers:

| Helper                   | Calling convention                                                           |
| ------------------------ | ---------------------------------------------------------------------------- |
| `mapOption`, `mapResult` | `mapOption(f)(option)`, `mapResult(f)(result)`                               |
| `withDefault`            | `withDefault(fallback)(option)`                                              |
| `andThen`                | `andThen(f)(result)`; `f` returns a `Result`                                 |
| `mapList`                | `mapList(f)(list)`                                                           |
| `foldList`               | `foldList(step)(initial)(list)`; `step(accumulator)(element)`, left to right |
| `head`                   | `head(list)` returns an `Option`                                             |
| `length`, `append`       | `length(list)`, `append(left)(right)`                                        |
| `range`                  | `range(start)(end)`, inclusive and increments by one                         |

`print` is the only intrinsic. It prints a value and returns `{}`; bind its result with `let` to sequence it. The command-line runner also prints the final result. The language adds `//` comments and multiple call arguments; all Rows record operations remain available.

## Compile, analyze, and deliberate limits

[`advanced.ts`](./advanced.ts) exports `compile(source, options?)` to parse, resolve imported modules, check types, and compile, plus `analyze(source, options?)` for editor facts without executing the program. The checker and elaborator are generator-based: `yield*` composes language-owned `Check` inference with raw portable IR declarations. Solver allocations and constraints are run-local; journaled updates and atomic constraint checking roll back partial mutations on failure. The optional elaboration adapter gathers declarations, while reusable consumers use Advanced's language-owned `elaborateBody` rather than a foreign adapter wrapper.

Independent operand checks can recover multiple diagnostics with source spans; recovery is restricted to checks that can safely continue and does not mean all branches recover. Diagnostics are plural, and compilation does not emit a target program when errors are present. Import `program` from `advanced-syntax.ts` for parsing and `show` for types. The optional module options support embedding with a chosen root URI/source reader. [`advanced-lsp.ts`](./advanced-lsp.ts) exposes analysis over stdio via `pnpm advanced:lsp`.

The CLI uses the JavaScript backend, but the portable IR is not JavaScript-specific or tied to TypeScript's type ontology and can be consumed by a selected backend. This is an explicitly annotated, predicative higher-rank language, not impredicative System F inference. Direct `forall` record fields, constructor payloads, and datatype arguments are unsupported. Record annotations are closed; open rows are inferred but cannot be explicitly quantified in annotations. Patterns do not have guards or literal cases. There are no type classes, subtyping, mutable references, or effect tracking. Numeric operations retain JavaScript semantics; use finite, practical ranges and lists. The VM runner is for trusted demonstrations, not a security sandbox.
