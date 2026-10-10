# Shapes

A small typed Lisp with structural records and Hindley–Milner row inference, built
with langkit. TypeScript inspires the structural requirements; Ur/Web inspires
unique-label rows and statically checked disjoint extension. This is a runnable
language experiment, **not** a port of either type system.

```sh
pnpm shapes                         # run main.shapes
pnpm shapes path/to/program.shapes
pnpm shapes:lsp                     # language server over stdio
node --test tests/shapes.test.ts
```

The sample returns:

```text
{ greeting: 'Hello, Ada', age: 37, language: 'Shapes', active: true, count: 42 }
```

## Structural shapes and preserved rows

```lisp
(shape Named {name string})
(def greet
  (fn [(person Named)]
    (concat "Hello, " (. person name))))

; Named requires `name`, but accepts and retains extra fields.
(greet {name "Ada" age 36})
```

A shape is a reusable record requirement, not a nominal class. Every use of
`Named` expands to `{name string ..fresh}`. Literal record annotations are exact:
`{name string}` rejects extra fields, while `{name string ..r}` preserves them.
Nested named shapes introduce their own fresh tails.

```lisp
(def birthday
  (fn [(person {age number ..r})]
    (update person age (+ (. person age) 1))))

(. (birthday {name "Ada" age 36}) name) ; string, "Ada"
```

The inferred type is effectively:

```text
{age: number, ..r} -> {age: number, ..r}
```

This is more precise than forgetting extra fields after a structural check.
The _same row_ appears in the input and output, so all unknown fields survive.
Unannotated projection and extension infer row requirements automatically:

```lisp
(def getName (fn [person] (. person name)))
(def activate (fn [person] (extend person {active true})))
(def compose (fn [f g x] (f (g x))))
(def celebrate (compose activate birthday))
```

`activate` has type `{..r} -> {active: boolean, ..r}` with the implicit constraint `r lacks active`.
Calling it with an already-active record is a **compile-time error**, even through
an alias or a higher-order function. Every generalized use receives fresh type
variables, row variables, and copies of their absence constraints.

Repeated `..r` within one function's parameter annotations means the same row:

```lisp
(fn [(left {x number ..r}) (right {y string ..r})]
  {left left right right})
```

Here both arguments must have the same remainder, and that remainder must lack
both `x` and `y`. Different names mean different tails. Annotation variables are
local to one `fn`; nested functions have fresh annotation scopes.

## Language reference

A program has zero or more `shape` / `def` / `macro` declarations followed by **one** result
expression. Definitions are sequential and non-recursive. Semicolon comments run
to the end of the line. Strings use JSON escapes. Names use letters/underscore,
then letters, digits, underscores, `?`, `!`, or `-`.

| Form                                     | Meaning                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `42`, `-2.5`, `1e3`, `true`, `"hello"`   | Number, boolean, and string literals                              |
| `{name "Ada" age 36}`                    | Immutable record; duplicate labels are rejected                   |
| `(fn [x y] body)`                        | Curried function; at least one parameter                          |
| `(fn [(x number) y] body)`               | Mix annotated and inferred parameters                             |
| `(f x y)`                                | Curried application; partial application is supported             |
| `(let [x value y other] body)`           | Sequential, lexical, polymorphic bindings                         |
| `(if condition then else)`               | Boolean condition; only the chosen branch runs                    |
| `(. record field)`                       | Require and project a field                                       |
| `(extend record {new value ...})`        | Add fields proven absent from the input                           |
| `(update record field value)`            | Require an existing field, replace its value and type             |
| `(merge left right)`                     | Disjoint merge; right must have a statically closed row           |
| `(select record [x y])`                  | Require fields and construct an exact record containing only them |
| `(shape Name {field Type ...})`          | Define an open structural record requirement                      |
| `(def name value)`                       | Top-level polymorphic binding                                     |
| `(macro name [argument ...] expression)` | Hygienic expression-template macro                                |

`update` may change the selected field's type, but never the original record:

```lisp
(let [original {age 36 name "Ada"}
      changed (update original age "unknown")]
  {old (. original age) new (. changed age) name (. changed name)})
; {old: number, new: string, name: string}
```

`select` deliberately forgets unselected fields. It is useful at boundaries and
for constructing a closed right-hand operand for `merge`.

All operands evaluate left-to-right. Record transformations evaluate the base
once, before their replacement/additional values. Field labels are syntax, not
dynamic strings. Records have unique labels, including safely emitted
`__proto__` and `constructor` fields.

### Types and inference

Types: `number`, `boolean`, `string`, `{field Type ...}`, `{field Type ... ..r}`,
named shapes, and curried function types `(-> A B)` / `(-> A B C)`.
`'a`, `'b`, etc. name shared inference variables in a function's annotations.

Both `def` and `let` generalize variables not free in the surrounding environment.
Function parameters are monomorphic. No value restriction is necessary: there is
no mutable state, even though `print` is an available effect.

Annotations **constrain inference**, rather than introducing rigid universally
quantified signatures. For example, accessing another field on an annotated
open row adds that requirement to the inferred function type. Similarly, an
annotated `'a` can specialize to `number`. Consult the inferred type to see the
complete contract. Named shapes can have inferred type variables in their field
types, but are not parameterized type constructors.

Branch types unify; Shapes does not synthesize unions or find a common width
supertype. Its structural behavior comes from row inference, not a general
TypeScript-style subtyping relation. There is no `any` or unchecked cast.

### Primitives

`+`, `-`, `*`, `/`, `>`, and `==` are ordinary curried binary functions on numbers.
`==` is numeric equality only. `concat` takes two strings. `print` accepts any
value and returns `{}`. Functions may shadow primitive names.

Numbers follow JavaScript IEEE-754 arithmetic (including division by zero and
`NaN`); non-finite **literals** are rejected.

## Hygienic expression-template macros

```lisp
(macro twice [value]
  (let [result value]
    (+ result result)))

(let [result 21]
  (twice result))
```

This evaluates to `42`. The template's `result` binding cannot capture the caller's
`result`. Likewise, free identifiers in a template refer to the values and macros
visible **where the macro was defined**, not caller shadows. For example, a macro
using `concat` still calls that definition-site function when its caller locally
binds a different `concat`. Named shapes in annotations are also definition-site.
Implementation uses scoped binding identities, not textual search-and-replace.

Parameters stand for **expressions only**. They can appear in function position,
so a pipeline macro can accept ordinary functions:

```lisp
(macro pipe [value first second]
  (second (first value)))

(macro activate [person]
  (extend person {active true}))

(def mark (fn [person] (activate person)))
(def birthday (fn [person] (update person age (+ (. person age) 1))))
(pipe {name "Ada" age 36} birthday mark)
```

The result retains `name`, increments `age`, and adds `active`. Applying `activate`
to a record that already has `active` fails the normal row absence constraint.

**Type safety means checking the expanded expression at each use**, through the
same inference and row solver as ordinary code. Macros do not have independently
verified universal type signatures. An unused template may therefore contain a
type error; using it reports the error at the outer macro call, with an expansion
context. Free expression names and template structure are checked at declaration.
No arbitrary compiler-time JavaScript, unchecked casts, or runtime macro objects
are involved.

A template controls evaluation: referencing an argument twice evaluates it twice;
put it in a `let` to evaluate once, as `twice` does above. An `if` can skip an
argument. An unused argument is neither elaborated nor evaluated. Macro calls are
not ordinary eager function calls.

Boundaries:

- Declarations are top-level and sequential. Templates may call earlier macros;
  self-reference, forward references, and mutually recursive macros are rejected.
- Parameters have fixed arity; zero parameters are allowed. Local template
  binders may shadow parameters. Ordinary value bindings shadow macro names in
  call position. A macro declaration cannot reuse an existing macro or value name.
- Macros are not first-class values: pass ordinary functions, not macro names, as
  callable arguments.
- No substitution in field labels, binder names, selection vectors, annotations,
  or row/type variable names. These retain their literal template meaning.
  `extend` templates require a literal record of added fields; use `merge` with
  an expression argument when a closed record operand is appropriate.
- No quoting, unquoting, variadic pattern rules, syntax splicing, or user-defined
  compiler-time computations.
- Expansion is bounded to 32 nested calls and 10,000 expression elaborations
  inside expansions per compilation. Each template traversal allows at most
  10,000 nodes and depth 64. Exceeding a limit is a source diagnostic.

Hover on a macro declaration shows its parameter list and identifies it as an
expression template typechecked at use, not a universally typed signature. Hover
on a call name also shows the concrete expanded result type. Go-to-definition
links call names to their lexical macro declaration, including calls to earlier
macros inside templates. Analysis exposes ordinary source arguments' references
and types; generated template-local bindings do not create misleading source
definitions. Independently typed template bodies are not implemented. A duplicated
argument may produce repeated analysis facts at the same source range; an unused
argument has no type facts.

Run the comment-free showcase for control flow, pipelines, row preservation, and
both caller-variable and definition-site hygiene:

```sh
pnpm shapes examples/shapes/macros.shapes
```

## Named shapes in editor types

Parameter annotations retain their shape names when it is safe to abbreviate:

```lisp
(shape Customer {name string email string})
(def greet (fn [(customer Customer)] (concat "Hello, " (. customer name))))
greet
```

The function hover is `(Customer -> string)`. Hovering on the shape declaration
or a `Customer` annotation shows its fields; go-to-definition from annotations
jumps to the shape declaration. References inside function-type annotations,
nested record annotations, and macro-template annotations are also tracked.
Shape names and value names have separate identities.

If the body requires another field, the hover says, for example,
`Customer & { member: boolean }`. `&` here is **display notation only**, not new
intersection syntax or a nominal type. Aliases are annotation provenance, not
names guessed for structurally matching inferred records. Structural acceptance
and all existing row constraints remain unchanged.

A shared remainder remains explicit: an identity function has type
`(Customer & { ..r } -> Customer & { ..r })`. Additional absence constraints
remain visible; only constraints already implied by the named or displayed
fields are omitted. Closed instantiations display their full exact record, not
an open shape name. Record transformations may display their result structurally
rather than carrying a name onto changed fields.

Abbreviation is deliberately conservative: shapes with inference variables or
open nested rows in their declared fields are expanded, so specialization and
field correlations cannot be hidden behind a bare name. Nested named shapes can
still appear inside those expanded fields. A shape with only fixed fields
(including exact nested records or fixed function types) can be abbreviated.
Macro definitions remain checked at use; observing their known type references
does not check unused templates or resolve names declared later.

## Compiler and editor API

```ts
import { compile, analyze, show } from "./shapes.ts";

const result = compile("(fn [r] (. r name))");
if (result.success) {
  console.log(show(result.value.type));
  // result.value.ir: langkit typed IR
  // result.value.javascript: emitted JavaScript expression
} else {
  // result.error: source-spanned langkit diagnostic
}
```

`analyze` provides expression types, value definitions/references, diagnostics,
and semantic tokens. The language server uses langkit's shared adapter. Record
labels do not yet have dedicated definition/reference facts;
comments are skipped by semantic highlighting. There is no import system.

Implementation:

- `shapes-syntax.ts`: source-spanned S-expression reader using parserator.
- `shapes-macros.ts`: bounded, scope-aware traversal of expression templates.
- `shapes-types.ts`: row/type unification, occurs checks, absence constraints,
  generalization and instantiation, adapted from the existing `rows` example.
- `shapes.ts`: syntax-directed inference, annotation policy, typed IR, analysis,
  JavaScript compilation, and CLI.

## Deliberate limits

This version has no recursive bindings/types, quoting, lists, mutation,
optional fields, union/intersection types, variants, rank-N polymorphism,
higher-kinded row constructors, mapped types, or Ur/Web-style row folders.
It also has no general concatenation of **two unknown open tails**: representing
that soundly needs richer disjointness constraints than the single-tail row
solver. Use `extend` or a closed right operand to `merge` instead.

Arbitrary field removal from an unknown row is not implemented; `select` supports
explicit narrowing without changing the shared IR. These boundaries are checked
or absent from the syntax, not bypassed with runtime casts.

Hover types use `..r` for open rows, keep short arrow tails together, and omit
absence constraints already implied by visible fields beside the same row tail.
Additional absence constraints remain visible under `where`; inference is unchanged.
