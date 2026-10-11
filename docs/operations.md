# IR operation contracts

Langkit's IR is extensible data, not a closed node union. Each `Value<T>` stores a language-owned type descriptor, an opaque `OperationNode`, and the exact `operationId` symbol of the descriptor instance that created it. Descriptor identity—not `kind`—selects both traversals and backend handlers. Kinds are descriptive labels and need not be globally unique.

An `OperationDescriptor` supplies four structural contracts:

- `children(node)` returns value children in **evaluation order**.
- `scopedBodies(node)` returns nested bodies, each paired with the bindings visible there.
- `references(node)` reports binding uses not represented as ordinary children.
- `map(node, mapValue, mapBody, mapBinding)` immutably rebuilds the node and all its IR-bearing parts.

`validate(node)` is an optional operation-local structural hook. Generic validation invokes it for a value after resolving that value by its exact descriptor identity, before traversing the descriptor-reported references, children, and scoped bodies. Use it for invariants internal to an operation representation (for example, duplicate case tags); it does not make type checking mandatory.

`defineOperation` adds the descriptor identity, `make(type, node)` constructor, and identity-sensitive `is(value)` predicate. A feature packages named `descriptors`, their derived runtime traversal list `operations`, and typed builder `methods`. `language.use(feature)` selects and composes them.

`defineDialect(record)` retains each literal key and descriptor type. `composeDialects(left, right)` rejects duplicate keys and identities. Backend tables derive callback node types and required handler keys from that record:

```ts
import { defineJavaScriptBackend } from "langkit/javascript/operations";
import { defineDialect } from "langkit/operations/dialect";

const dialect = defineDialect({ twice });
const handlers = defineJavaScriptBackend(dialect, {
  twice: (node, context) => `(${context.expr(node.value, context.depth)} * 2)`,
});
```

`definePythonBackend` supplies the Python context. For another output format, `defineBackend<Context, Output>()` accepts a dialect and its complete handler table. Runtime composition still rejects handler identity collisions.

Selecting a descriptor freezes its configuration object. Traversal entries capture its callbacks and are frozen. Later changes to a mutable structural descriptor alias are rejected. Callback implementations still own the semantics and any data they capture.

Descriptor records require own enumerable string keys. Backend factories require an own callable handler for every selected key and capture those callbacks at creation. Explicit keys such as `toString`, `constructor`, and `valueOf` are legal; inherited `Object.prototype` methods cannot supply handlers. TypeScript checks inferred key coverage, while runtime validation remains authoritative for interfaces and index signatures that cannot express property ownership.

## Structural validation and mapping

`Body<T>` is a scoped fragment containing declarations and a result. `Program<T>` adds the selected traversal registry and optional core function identity. `language.program(body)` snapshots the registry. Installing another feature later does not modify an existing program. Descriptor instances remain shared identities.

`language.validate(body)` is a builder convenience. Standalone `validate(program)` and JavaScript `emit(program, handlers?)` use the program's registry. `createJavaScriptEmitter(...handlerSets).emit(program)` composes handler sets. Python provides the same emitter form.

Validation is structural, not a proof of language typing. It does not check that a value's `type` agrees with a literal, operator, field, or result. Each language owns its typing rules; the core IR deliberately permits language-specific descriptors and does not require a type checker.

`mapBody(body, operations, mapBinding?, transformValue?)` maps a scoped fragment using exact descriptor identities. For a portable program, use `mapBody(program.body, program.operations, ...)` to preserve the registry associated with its values. Mapper arguments default to identity. `transformValue(original, mapped)` runs bottom-up after the descriptor has mapped that value's children; it can replace the reconstructed value. The descriptor map must preserve every child, body, scoped binding, and reference-bearing structure in its node, or deliberately transform it. `mapBody` does not revalidate the transformed result or prove type preservation; transformations that alter language-level invariants must maintain or recheck them. Missing descriptors throw rather than guessing from `kind`.

References are descriptor-reported uses. Core references are narrowable with `isReference(value, language.coreReferenceId())`; checking `node.kind === "ref"` alone is not identity-safe in an extensible IR.

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

`State<T>` from `state(init, checkpoint)` is mutable, run-local storage; `checkpoint(value)` must return a restore callback. `Scoped<T>` from `scoped(initial)` is an immutable environment binding. `get` reads either; `within(scopedKey, update, body)` derives a temporary binding by invoking only the updater callback, and `bind` extends readonly map environments. Every `run` gets fresh storage. `recover()` accumulates a diagnostic and continues only for void checks; even if later work succeeds, `run` returns failure with `errors: readonly [Diagnostic, ...Diagnostic[]]` whenever any diagnostic was recovered. Do not emit a program on that result. `atomic()` restores mutable run-local state on terminal failure or throw; `attempt(check)` additionally removes diagnostics recovered inside it and rolls back; `choice(...checks)` isolates alternatives and uses the first success, or first failure when all fail; `sequence(tuple)` returns values in a tuple preserving the checks' input order. Implementation exceptions propagate.

Fresh inference allocation, instantiation, and generalization are checks composed with `yield*`, `map`, or `flatMap` inside the caller's run; inference helpers do not invoke nested runs. Journaled `assign`, `add`, `put`, and `append` undo object-property, set, map, and array writes during rollback without deep snapshots on each solver step. `pruneLink(value, variable, instance)` traverses links read-only and never compresses them. This compositional transactional checker/inference model is informed by typerator state/recovery and ts-macros-inspired generator IR, but does not import their JavaScript/TypeScript syntax assumptions or impose any source-language type ontology.

| Operation | Children, left to right | Scoped bodies and structural role                                                                                              |
| --------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `literal` | none                    | No bindings or references.                                                                                                     |
| `ref`     | none                    | `references` reports its target binding.                                                                                       |
| `binary`  | left, right             | The order is the language's operand evaluation order.                                                                          |
| `call`    | function, argument      | The callee is visited before the argument.                                                                                     |
| `fn`      | none                    | Its body is scoped by its parameter binding. Creating a function does not evaluate that body at target function-creation time. |
| `if`      | condition               | Then body followed by else body, both structurally traversed; at runtime only the selected branch executes.                    |
| `block`   | none                    | Its body is a nested scope.                                                                                                    |

## Records and merge

Select `records<T>()` for `record`, `merge`, and `field` operations. A record evaluates its field values in source order, then its optional base; handlers preserve that order and evaluate each value once. The base is spread first and explicit fields override same-named base fields. `merge` evaluates left then right and right-side fields override left-side fields. A field selection evaluates its record expression once, then reads the named property. These operations describe runtime representation and order; they do not establish row typing, duplicate-field validity, or field existence. Those are language-owned checks.

The JavaScript representation is a null-prototype object. Python represents records with native dictionaries; the core does not require every backend to use either representation.

## Variants and matches

Select `variants<T>()` for `variant` and `match`. A variant evaluates payload fields left to right. JavaScript represents it as a null-prototype object with `tag` and `fields` properties; Python uses a native dictionary with the same keys and a list of payload values. A match evaluates its scrutinee once, then enters the matching branch body; branch bindings pair with payload entries by position and are visible only inside that branch. An optional fallback can bind the whole variant. Without a fallback, emitted code raises an internal non-exhaustive-match error if no branch matches.

Duplicate match case tags are rejected by the match descriptor structural hook. The validity of individual tags, constructor arity, exhaustiveness, branch result types, and compatibility between variant and match remain language-owned invariants; the structural hook does not perform those checks.

## Printing

Select `printing<T>()` for `print` and the backend's corresponding handler (`printingJavaScript` or `printingPython`). The operation has one child, evaluated exactly once before the print effect, and returns the backend's empty-record representation. JavaScript calls `console.log` and returns a null-prototype empty object; Python calls built-in `print` and returns `{}`. Printed formatting is host-native: Python uses Python's `print`/`str` representation and is not intended to mimic JavaScript `console.log` formatting. Output typing and the meaning/availability of the host print facility belong to the language/backend environment.

## Folder operations and fold order

Select `folders<T>()` for `field-order` and `record-fold`. `field-order` has no IR value children; its ordered string list is metadata stored in the node. `record-fold` visits its five value children in this exact order: explicit field order, metadata, record, initial accumulator, and step function. Its handlers use that order to traverse requested fields and apply the step function while carrying the accumulator. The generic folder descriptor does not know what metadata means, whether the order matches record fields, or what types the step function accepts; those are language-owned constraints.

## Python backend

The Python backend is exported from `langkit/python` with feature handler sets from `langkit/python/*`. Compose only the handlers for the descriptors/features selected by a builder. A typical composition uses `corePython(code.coreDescriptors)`, plus `recordsPython(recordFeature.descriptors)`, `variantsPython(variantFeature.descriptors)`, `printingPython(printingFeature.descriptors)`, or `foldersPython(folderFeature.descriptors)` as needed:

```ts
const emitter = createPythonEmitter(
  corePython(code.coreDescriptors),
  recordsPython(recordFeature.descriptors),
  variantsPython(variantFeature.descriptors),
  printingPython(printingFeature.descriptors),
  foldersPython(folderFeature.descriptors),
);
const source = emitter.emit(program);
```

`emit(program)` validates and returns executable Python source; it does not run the program, launch Python, or print the result automatically. The generated module assigns its final value to `result`, so an embedding host can inspect it or explicitly print it. The current backend requires Python 3.8 or newer and uses native lambdas, assignment expressions, floats, math helpers, dictionaries/tag-field variants, and reduction-based record folds.

The numeric core targets JavaScript-like floating-point behavior: numeric literals are emitted as Python floats (including explicit signed zero, NaN, and infinities), division handles zero divisors as IEEE-style NaN/infinity rather than Python's zero-division exception, and strict equality treats numeric values by numeric value (including signed zeros), booleans separately from numbers, strings by value, and other objects by identity. Python print formatting is nevertheless native Python formatting, not JavaScript console formatting.

Only type-correct arithmetic and field access are promised. The backend does not provide a cross-language contract for invalid operand types, mismatched record/variant shapes, or malformed fold inputs; those cases depend on language-owned typing and host behavior and should not be used as portable programs.

### Custom Python handlers

A custom Python handler must be selected by the exact descriptor identity of its operation, not merely its kind. `definePythonHandler(descriptor, emit)` binds a handler directly to a descriptor; use `asDispatcherHandler` to include it in an emitter handler set. Alternatively, `definePythonBackend(defineDialect(feature.descriptors), handlers)` defines a complete typed handler table for a feature's named descriptors. The handler receives the IR node plus `PythonContext<T>` (`expr`, `block`, `name`, and nesting depth) and returns Python expression source. A custom handler must preserve child evaluation order and scope/effect semantics just like a built-in backend handler.

`createPythonEmitter(...handlerSets)` composes sets; duplicate descriptor IDs are rejected, as are missing handlers when emission reaches a selected operation with no implementation. Built-in Python feature sets and custom handlers can be composed together. Identity collisions in `kind` do not dispatch a handler, and a handler created for a different descriptor instance cannot implement this program's operation.

## Authoring custom operations

A custom descriptor must expose every value child in runtime evaluation order and every nested body with exactly the bindings valid there. Put binding uses in `references` when they are not modeled as child values. `map` must rebuild all of this IR data, including scoped bindings, so validation and transformations see the same structure as execution. Omitting a child, nested body, or reference makes generic validation/mapping incomplete. A descriptor cannot claim recursive declaration privileges; only the selected core function descriptor is accepted as a recursive initializer.

For JavaScript, define a handler tied to that exact descriptor, then include it in a `createJavaScriptEmitter` handler set. Core and feature handler factories must receive the same selected descriptor instances used to build IR. The emitter validates the `Program` registry; an unselected IR value fails validation, and a selected operation with no identity-matched handler throws `Missing JavaScript handler for operation: <kind>`. A same-kind handler from another descriptor instance does not match.

## Composition example

The [README examples](../README.md#compose-an-ir-and-backend) run one generator-authored program on JavaScript and Python, then show how to add a typed custom operation. Their type labels belong to the example language; the framework does not infer or validate their meaning.
