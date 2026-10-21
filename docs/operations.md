# IR operation contracts

Langkit's IR is extensible data, not a closed node union. Each `Value<T>` stores a language-owned type descriptor, an opaque `OperationNode`, and the exact `operationId` symbol of the descriptor instance that created it. Descriptor identity—not `kind`—selects both traversals and backend handlers. Kinds are descriptive labels and need not be globally unique.

An `OperationDescriptor` supplies three structural contracts. Each defaults to none:

- `children(node)` returns value children in **evaluation order**.
- `scopedBodies(node)` returns nested bodies, each paired with the bindings visible there.
- `references(node)` reports binding uses not represented as ordinary children.

`validate(node)` is an optional operation-local structural hook. Generic validation invokes it for a value after resolving that value by its exact descriptor identity, before traversing the descriptor-reported references, children, and scoped bodies. Use it for invariants internal to an operation representation (for example, duplicate case tags); it does not make type checking mandatory.

`defineOperation` adds the descriptor identity, `make(type, node)` constructor, and identity-sensitive `is(value)` predicate. A feature packages named `descriptors` and typed builder `methods`. `language.use(feature)` selects them and rejects duplicate method names and descriptor identities.

A JavaScript backend table derives callback node types and required handler keys from the same descriptor record:

```ts
import { defineJavaScriptBackend } from "langkit/javascript";

const handlers = defineJavaScriptBackend({ twice }, {
  twice: (node, context) => `(${context.expr(node.value, context.depth)} * 2)`,
});
```

`createJavaScriptEmitter` rejects two handlers for the same descriptor identity.

## Structural validation

`Body<T>` is a scoped fragment containing declarations and a result. `Program<T>` adds the selected descriptor registry and the core function identity. `language.program(body)` snapshots the registry. Installing another feature later does not modify an existing program. Descriptor instances remain shared identities.

`validate(program)` and `createJavaScriptEmitter(...handlerSets).emit(program)` use the program's registry.

Validation is structural, not a proof of language typing. It does not check that a value's `type` agrees with a literal, operator, field, or result. Each language owns its typing rules; the core IR deliberately permits language-specific descriptors and does not require a type checker.

References are descriptor-reported uses. Core references are narrowable with `language.coreDescriptors.ref.is(value)`; checking `node.kind === "ref"` alone is not identity-safe in an extensible IR.

## Core operations and generator construction

Core is installed by `create<T>()`; it includes primitive expression operations only. Richer operations are selected separately. The core builder is pure IR construction and has no `Check` dependency:

- `body(source)` accepts either a `Body<T>` or a factory returning `Generator<Declaration<T>, Value<T>, unknown>`.
- `declare(name, initial)` is a generator: `yield*` it to add a non-recursive declaration and receive its `Reference<T>`.
- `declareRecursive(binding, functionValue)` is a generator that adds a recursive declaration and returns a reference to the supplied binding. Its initializer must be a function value created by this builder's core `fn` descriptor identity; arbitrary values and functions from another descriptor instance are rejected.
- `fn(type, parameter, bodySource)`, `conditional(type, condition, thenSource, elseSource)`, `block(type, bodySource)`, and `scope(bodySource)` accept a `Body<T>` or a generator factory. `scope` packages a body as a core block value.

For example, ordinary declarations can be composed in the body generator:

```ts
const programBody = language.body(function*() {
  const saved = yield* language.declare("saved", expression);
  return saved;
});
const program = language.program(programBody);
```

Each execution of `declare(...)` creates a fresh ordinary binding and ID. A generator factory is intended to build a new scoped body each time it is called; this makes repeated construction produce distinct bindings rather than accidentally aliasing IDs. Within one body construction, call `declare` once and retain/use the returned reference as often as needed. Do not call it repeatedly to mean “reference the same declaration”: each call creates another declaration and binding ID.

Build-time callbacks are materialized immediately into IR bodies: the `fn` body factory runs while constructing the function value, and both `conditional` branch factories run while constructing the conditional. Their resulting IR remains lazy at target execution: a function body runs only when called, and only the selected conditional branch executes. `block`/`scope` bodies run when the block expression executes. This separation lets traversal inspect all nested IR while target execution preserves function and branch laziness.

At a checking boundary, configure operation features on the pure builder and then call `elaboration(builder)` from `langkit/ir/check`. The resulting adapter exposes `check(factory)`, `body(factory)`, and `scope(factory)`; each factory yields `Check<unknown> | Declaration<T>` and returns its ordinary value. `check` composes checks with optional declaration yields; declaration yields are valid only while an enclosing `body` factory of that adapter is collecting them. `body` collects mixed computation into a `Check<Body<T>>`; `scope` returns a checked block value. These are factory APIs, not Check-argument overloads. Configure features before wrapping; the adapter intentionally does not expose feature selection.

Raw `declare(name, initial)` and `declareRecursive(binding, functionValue)` remain pure generator methods on both builder and adapter: each yields a declaration and returns a reference. They do not allocate IR through a Check protocol. Pure builder methods remain Check-free: `body`, `fn`, `conditional`, `block`, and `scope` accept a `Body<T>` or pure body factory. `program(body)` validates immediately. The portable program retains selected descriptor identities, and validation preserves lexical declaration/reference scope.

## Checker and inference composition

`elaboration(builder)` adapts an already configured pure builder. Its mixed factories yield checks and declaration objects. Declaration yields require an enclosing adapter body. Pure `declare` and `declareRecursive` generators remain the declaration protocol. Each checked body execution has a fresh collector and publishes a copied declaration array.

`code.program(body)` validates structure and snapshots the registry. Descriptor identities and lexical binding links remain intact. Pure builder methods stay independent of `Check`.

`State<T>` from `state(init, checkpoint)` is mutable, run-local storage; `checkpoint(value)` must return a restore callback. `Scoped<T>` from `scoped(initial)` is an immutable environment binding. `get` reads either; `within(scopedKey, update, body)` derives a temporary binding by invoking only the updater callback, and `bind` extends readonly map environments. Every `run` gets fresh storage. `recover()` accumulates a diagnostic and continues only for void checks; even if later work succeeds, `run` returns failure with `errors: readonly [Diagnostic, ...Diagnostic[]]` whenever any diagnostic was recovered. Do not emit a program on that result. `atomic()` restores mutable run-local state on terminal failure or throw. Implementation exceptions propagate.

Fresh inference allocation, instantiation, and generalization are checks composed with `yield*`, `map`, or `flatMap` inside the caller's run; inference helpers do not invoke nested runs. Journaled `assign` and `add` undo object-property and set writes during rollback without deep snapshots on each solver step. `pruneLink(value, variable, instance)` traverses links read-only and never compresses them. This compositional transactional checker/inference model is informed by typerator state/recovery and ts-macros-inspired generator IR, but does not import their JavaScript/TypeScript syntax assumptions or impose any source-language type ontology.

| Operation | Children, left to right | Scoped bodies and structural role                                                                                              |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `literal` | none                    | No bindings or references.                                                                                                     |
| `ref`     | none                    | `references` reports its target binding.                                                                                       |
| `binary`  | left, right             | The order is the language's operand evaluation order.                                                                          |
| `call`    | function, argument      | The callee is visited before the argument.                                                                                     |
| `fn`      | none                    | Its body is scoped by its parameter binding. Creating a function does not evaluate that body at target function-creation time. |
| `if`      | condition               | Then body followed by else body, both structurally traversed; at runtime only the selected branch executes.                    |
| `block`   | none                    | Its body is a nested scope.                                                                                                    |

## Records

Select `records<T>()` for `record` and `field` operations. A record evaluates its field values in source order, then its optional base; handlers preserve that order and evaluate each value once. The base is spread first and explicit fields override same-named base fields. A field selection evaluates its record expression once, then reads the named property. These operations describe runtime representation and order; they do not establish row typing, duplicate-field validity, or field existence. Those are language-owned checks.

The JavaScript representation is a null-prototype object. The core does not require every backend to use it.

## Variants and matches

Select `variants<T>()` for `variant` and `match`. A variant evaluates payload fields left to right. JavaScript represents it as a null-prototype object with `tag` and `fields` properties. A match evaluates its scrutinee once, then enters the matching branch body; branch bindings pair with payload entries by position and are visible only inside that branch. An optional fallback can bind the whole variant. Without a fallback, emitted code raises an internal non-exhaustive-match error if no branch matches.

Duplicate match case tags are rejected by the match descriptor structural hook. The validity of individual tags, constructor arity, exhaustiveness, branch result types, and compatibility between variant and match remain language-owned invariants; the structural hook does not perform those checks.

## Printing

Select `printing<T>()` for `print` and the backend's corresponding handler (`printingJavaScript`). The operation has one child, evaluated exactly once before the print effect, and returns the backend's empty-record representation. JavaScript calls `console.log` and returns a null-prototype empty object. Output typing and the meaning/availability of the host print facility belong to the language/backend environment.

## Authoring custom operations

A custom descriptor must expose every value child in runtime evaluation order and every nested body with exactly the bindings valid there. Put binding uses in `references` when they are not modeled as child values. Omitting a child, nested body, or reference makes generic validation incomplete. A descriptor cannot claim recursive declaration privileges; only the selected core function descriptor is accepted as a recursive initializer.

For JavaScript, define a handler tied to that exact descriptor, then include it in a `createJavaScriptEmitter` handler set. Core and feature handler factories must receive the same selected descriptor instances used to build IR. The emitter validates the `Program` registry; an unselected IR value fails validation, and a selected operation with no identity-matched handler throws `Missing JavaScript handler for operation: <kind>`. A same-kind handler from another descriptor instance does not match.

## Composition example

The [README examples](../README.md#compose-an-ir-and-backend) run one generator-authored program on JavaScript, then show how to add a typed custom operation. Their type labels belong to the example language; the framework does not infer or validate their meaning.
