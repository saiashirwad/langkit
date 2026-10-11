# Changelog

## Unreleased — composable operation descriptors (breaking)

The compiler's public `ir` result is now a portable `Program<T>` rather than a bare `Body<T>`. JavaScript emission and standalone structural validation now consume that program directly; the former per-call emit options API is removed. This is a breaking clean cutover with no compatibility overloads.

- `create<T>()` is the core builder. Add optional capabilities explicitly with `.use(records<T>())`, `.use(variants<T>())`, `.use(printing<T>())`, `.use(folders<T>())`, or custom `OperationFeature` values.
- Every `Value<T>` now requires `operationId`; `node` is an opaque `OperationNode`, not a closed `Node`/`BuiltinNode` union. Construct extension values through descriptor `make` methods and narrow with that descriptor's `is` predicate.
- Operation descriptors now provide ordered `children`, `scopedBodies`, `references`, and immutable `map` reconstruction. Custom operations must implement all four structural contracts.
- JavaScript emission uses explicit `createJavaScriptEmitter(...)` handler sets. Core and feature handler factories must receive the exact descriptor instances selected by the builder. Pass `operations: code.operationTraversals()` and `coreFunctionId: code.coreFunctionId()` to `emit`; missing or mismatched handlers fail instead of dispatching by kind.
- Validation is descriptor-driven. Use `code.validate(body)` or `validate(body, operations, coreFunctionId?)`; `mapBody(body, operations, mapBinding?, transformValue?)` also needs the selected operation registry. Recursive declaration validation is enabled only for the selected core function operation.
- Reference checks now require the selected core reference identity: `isReference(value, code.coreReferenceId())`.
- The core builder contains only primitive expression operations. Records, variants/matches, printing, and folders are opt-in. Automatic all-feature emitters and closed-union assumptions are no longer supported.

See the root [framework introduction](README.md) and [operation contract guide](docs/operations.md) for migration examples and current traversal, validation, mapping, and runtime contracts.
