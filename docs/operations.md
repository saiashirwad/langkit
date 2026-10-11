# IR operation contracts

Langkit's IR is extensible data, not a closed node union. Each `Value<T>` stores a language-owned type descriptor, an opaque `OperationNode`, and the exact `operationId` symbol of the descriptor instance that created it. Descriptor identity—not `kind`—selects both traversals and backend handlers. Kinds are descriptive labels and need not be globally unique.

An `OperationDescriptor` supplies four structural contracts:

- `children(node)` returns value children in **evaluation order**.
- `scopedBodies(node)` returns nested bodies, each paired with the bindings visible there.
- `references(node)` reports binding uses not represented as ordinary children.
- `map(node, mapValue, mapBody, mapBinding)` immutably rebuilds the node and all its IR-bearing parts.

`validate(node)` is an optional operation-local structural hook. Generic validation invokes it for a value after resolving that value by its exact descriptor identity, before traversing the descriptor-reported references, children, and scoped bodies. Use it for invariants internal to an operation representation (for example, duplicate case tags); it does not make type checking mandatory.

`defineOperation` adds the descriptor identity, `make(type, node)` constructor, and identity-sensitive `is(value)` predicate. A feature packages descriptors (`operations`) with its typed builder methods (`methods`); `language.use(feature)` explicitly selects and composes them.

## Structural validation and mapping

`language.validate(body)` validates against that builder's selected operations; standalone `validate(body, operations, coreFunctionId?)` takes the same registry explicitly. Validation rejects duplicate descriptor identities, values without a selected traversal, duplicate binding declarations, and out-of-scope references. It visits declared values in declaration order, then each body's result; a descriptor determines child and nested-body order. Scoped body parameters become visible within that body. Non-recursive declarations become visible only after their initializer is visited. Recursive declarations are accepted only when the caller provides the selected core function descriptor identity and the initializer uses that identity; arbitrary extension operations cannot opt themselves into recursive initialization.

Validation is structural, not a proof of language typing. It does not check that a value's `type` agrees with a literal, operator, field, or result. The language checker owns those invariants.

`mapBody(body, operations, mapBinding?, transformValue?)` uses the same exact descriptor identities to reconstruct all values, declarations, nested bodies, and bindings. Its mapper arguments default to identity. `transformValue(original, mapped)` runs bottom-up after the descriptor has mapped that value's children; it can replace the reconstructed value. The descriptor map must preserve every child, body, scoped binding, and reference-bearing structure in its node, or deliberately transform it. `mapBody` does not revalidate the transformed result or prove type preservation; transformations that alter language-level invariants must maintain or recheck them. Missing descriptors throw rather than silently skipping opaque nodes.

References are descriptor-reported uses. Core references are narrowable with `isReference(value, language.coreReferenceId())`; checking `node.kind === "ref"` alone is not identity-safe in an extensible IR.

## Core operations

Core features are installed by `create<T>()`; their constructors are the builder's small mandatory basis. All richer operations are selected separately.

| Operation | Children, left to right | Scoped bodies and structural role |
| --- | --- | --- |
| `literal` | none | No bindings or references. |
| `ref` | none | `references` reports its target binding. |
| `binary` | left, right | The order is the language's operand evaluation order. |
| `call` | function, argument | The callee is visited before the argument. |
| `fn` | none | Its body is scoped by its parameter binding. Creating a function does not evaluate that body at function-creation time. |
| `if` | condition | Then body followed by else body, both structurally traversed; at runtime only the selected branch executes. |
| `block` | none | Its body is a nested scope. |

A `Body<T>` is declarations plus a result value. Within a body, declarations execute in order before its result. `declare` appends a non-recursive declaration to the enclosing body; `declareRecursive` only accepts a core function value and creates a recursive declaration. `scope(check)` captures a body as a core block value. The JavaScript core backend emits functions/branches/scopes as JavaScript functions or IIFEs, retaining lexical scope and branch laziness.

## Records and merge

Select `records<T>()` for `record`, `merge`, and `field` operations. A record evaluates its field values in source order, then its optional base; the JavaScript handler uses ordered function arguments so each value is evaluated once. The base is spread first and explicit fields override same-named base fields. `merge` evaluates left then right and right-side fields override left-side fields. A field selection evaluates its record expression once, then reads the named property. These operations describe runtime representation and order; they do not establish row typing, duplicate-field validity, or field existence. Those are language-owned checks.

The JavaScript representation is a null-prototype object. Record fields become string-keyed properties; merge constructs a new null-prototype object. The core does not require every backend to use this representation.

## Variants and matches

Select `variants<T>()` for `variant` and `match`. A variant evaluates payload fields left to right and is represented by the JavaScript handler as a null-prototype object with `tag` and `fields` properties. A match evaluates its scrutinee once, then enters the matching branch body; branch bindings pair with payload entries by position and are visible only inside that branch. An optional fallback can bind the whole variant. Without a fallback, emitted JavaScript throws an internal non-exhaustive-match error if no branch matches.

Duplicate match case tags are rejected by the match descriptor structural hook. The validity of individual tags, constructor arity, exhaustiveness, branch result types, and compatibility between variant and match remain language-owned invariants; the structural hook does not perform those checks.

## Printing

Select `printing<T>()` for the `print` operation and `printingJavaScript` for its JavaScript handler. It has one child, evaluated exactly once before the print effect. The current handler calls `console.log` with that value and returns a null-prototype empty object. The operation constructor accepts a result type descriptor supplied by the language; output typing and the meaning/availability of `console` belong to the language/backend environment.

## Folder operations and fold order

Select `folders<T>()` for `field-order` and `record-fold`. `field-order` has no IR value children; its ordered string list is metadata stored in the node. `record-fold` visits its five value children in this exact order: explicit field order, metadata, record, initial accumulator, and step function. Its current JavaScript handler uses that order to traverse the requested fields and apply the step function while carrying the accumulator. The generic folder descriptor does not know what metadata means, whether the order matches record fields, or what types the step function accepts; those are language-owned constraints.

## Authoring custom operations

A custom descriptor must expose every value child in runtime evaluation order and every nested body with exactly the bindings valid there. Put binding uses in `references` when they are not modeled as child values. `map` must rebuild all of this IR data, including scoped bindings, so validation and transformations see the same structure as execution. Omitting a child, nested body, or reference makes generic validation/mapping incomplete. A descriptor cannot claim recursive declaration privileges.

For JavaScript, define a handler tied to that exact descriptor, then include it in a `createJavaScriptEmitter` handler set. Core and feature handler factories must receive the same selected descriptor instances used to build IR. The emitter validates using the `operations` passed to `emit`; an unselected IR value fails validation, and a selected operation with no identity-matched handler throws `Missing JavaScript handler for operation: <kind>`. A same-kind handler from another descriptor instance does not match.

## Composition example

The [README example](../README.md#compose-an-ir-and-backend) selects core and records, adds a typed custom operation, and runs its JavaScript backend. Its type labels belong to the example language; the framework does not infer or validate their meaning.
