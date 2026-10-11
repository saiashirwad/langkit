# Syntax declarations

`langkit/syntax` provides an optional recursive expression schema. Ordinary user-defined ASTs remain usable without it. The schema derives constructors, node types, immediate-child mapping, and explicit binder-aware traversal. Parsing and typing are separate.

```ts
import { defineSyntax, syntax, type NodeOf } from "langkit/syntax";

const expressions = defineSyntax({
	number: syntax.node("number", { value: syntax.data<number>() }),
	fn: syntax.node("fn", {
		parameter: syntax.binder(),
		body: syntax.scopedChild({ binds: ["parameter"] }),
	}),
});
type Expr = NodeOf<typeof expressions>;

const expression: Expr = expressions.make.fn({
	parameter: syntax.binding("x"),
	body: expressions.make.number({ value: 42 }),
}, { span: { start: 0, end: 12 } });
```

Schema keys must match node kinds. `binds` selects only declared binder fields. Constructors preserve exact scalar types and use the recursive node union for children.

## Fields

`data<T>()` declares required scalar or plain structured data. `optionalData<T>()` declares optional data. `binder()` declares a binding identity created by `binding(name)`.

`child()`, `children()`, and `entries()` declare one child, a child list, and a labelled child list. Each labelled entry contains `label` and `child`. Their scoped counterparts accept `{ binds: [...] }`.

A scoped child sees only the binder fields selected for that edge, plus outer traversal bindings. The schema does not infer whether a let is recursive, sequential, or visible in its initializer. Those policies require explicit edges or language-specific handling.

## Identity and snapshots

Each construction creates a symbol ID. Mapping preserves a parent's ID and optional span. IDs identify construction instances, not stable positions across reparses.

Schemas, nodes, lists, spans, and plain data are frozen snapshots. Data supports primitives, plain objects, and arrays. Cycles, functions, and objects such as `Map` and `Date` fail at construction. Scalar types are checked by TypeScript, not by runtime validators.

Runtime construction, mapping, and traversal reject nodes from another schema. Independently created schemas can still have identical structural TypeScript types, so runtime membership checks remain necessary.

## Traversal

`children(node)` returns immediate `ChildEdge` records in field declaration order. Each edge identifies its field, child, optional list index and label, and selected binders. `visitChildren` invokes a callback over those edges.

`map(node, callback)` maps immediate children. It preserves unchanged data, labels, binders, spans, and IDs. It returns the original node when no child changes. Recursive transformation is a caller policy.

`walkScoped(node, callback)` traverses the tree with an explicit work stack. Its context contains the parent, edge, and visible binder list. It does not resolve names or check typing rules.

`tests/syntax.test.ts` and `tests/syntax-types.ts` cover construction, scopes, mapping, snapshots, membership, and inferred callback types. The walker test traverses 20,000 nested nodes.
