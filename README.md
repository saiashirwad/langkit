# langkit

Langkit is a TypeScript toolkit for building language-specific parsers, checkers, intermediate representations, backends, analyzers, and language servers. These are cooperating pieces, not a required compiler pipeline: there is no mandatory language object, type ontology, or lowering sequence. A language chooses the pieces and invariants it needs.

Requires Node.js 24.2+ and pnpm.

```sh
pnpm install
pnpm toy examples/toy/main.toy
pnpm typecheck
pnpm test
```

## Compose an IR and backend

The IR is extensible and descriptor-driven. `create<T>()` supplies the small core; optional operation sets add methods and descriptors explicitly. A value carries the language's own type descriptor and the exact identity of its operation descriptor. The framework does not define the language's type system.

This executable example selects core and records, then adds a typed custom operation with its own traversal and JavaScript handler:

```ts
import { runInNewContext } from "node:vm";
import { create, type Body, type OperationNode, type Value } from "langkit/ir";
import { defineOperation, traversalOf } from "langkit/operations/descriptor";
import { records } from "langkit/operations/records";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { recordsJavaScript } from "langkit/javascript/records";
import { asDispatcherHandler, defineJavaScriptHandler } from "langkit/javascript/operations";
import type { JavaScriptContext } from "langkit/javascript";

type Type = "number" | "object";
type Twice = OperationNode & { readonly kind: "twice"; readonly value: Value<Type> };
const twice = defineOperation<Type, Twice>("twice", {
  children: (node) => [node.value], scopedBodies: () => [], references: () => [],
  map: (node, mapValue) => ({ ...node, value: mapValue(node.value) }),
});
const recordFeature = records<Type>();
const code = create<Type>().use(recordFeature).use({
  operations: [traversalOf(twice)],
  methods: { twice: (type: Type, value: Value<Type>) => twice.make(type, { kind: "twice", value }) },
});
const handlers = createJavaScriptEmitter(
  coreJavaScript(code.coreOperationTraversals()),
  recordsJavaScript(recordFeature.operations),
  [asDispatcherHandler(defineJavaScriptHandler<Type, Twice, JavaScriptContext<Type>>(
    twice, (node, context) => `(${context.expr(node.value, context.depth)} * 2)`,
  ))],
);
const result = code.field("number", code.record("object", [
  { name: "answer", value: code.twice("number", code.literal("number", 21)) },
]), "answer");
const body: Body<Type> = { declarations: [], result };
const js = handlers.emit(body, {
  operations: code.operationTraversals(), coreFunctionId: code.coreFunctionId(),
});
console.log(runInNewContext(js)); // 42 (trusted demonstration only)
```

Each selected descriptor owns child evaluation order, scoped bodies and bindings, references, and immutable reconstruction. Backend handlers are matched by exact descriptor identity, not by operation name. Emission validates the root against the selected traversals and throws if a selected operation has no handler. `validate` checks structural scope and declaration invariants; it does not prove language-level typing. [Operation contracts and runtime representations](docs/operations.md) cover the complete API, recursion option, mapper contract, and built-in features.

## Optional tools

- **Parsing:** `langkit/parse` re-exports parserator parsers, generators, precedence, cuts, and source locations.
- **Checking and diagnostics:** `langkit` provides composable synchronous `Check` computations, scoped state/name lookup, and structured diagnostics. Expected source failures use `fail`; implementation exceptions propagate; checks stop at the first error. `Check.inDocument(uri)` optionally attaches a document identity to failures for module routing while preserving nested source origins; human-readable `context` labels are not machine source locations.
- **Inference:** `langkit/inference` contains reusable inference primitives, but selecting or integrating an inference strategy is the language author's choice. Several examples implement their own inference.
- **Modules:** `langkit/modules` provides a local-file module graph/loader for languages that want imports; it is optional. Analyses can include transitive dependency URIs and source snapshots.
- **Analysis and editor support:** `langkit/analysis` optionally collects UTF-16 source ranges for types, definitions, references, lexical tokens, and diagnostics. `langkit/lsp` serves language-provided analysis over LSP, including dependency-aware re-analysis when imported documents change. Diagnostics retain structured source locations and related information for imported-source errors.
- **JavaScript:** `langkit/javascript` validates and emits an expression using explicitly composed handlers. Feature handler sets must use the same operation descriptor instances as the IR builder. Emission is not a source-map generator.

The core IR's scope validation and the language's type checker have different responsibilities. Constructors trust the language's typing rules, and a custom operation handler defines backend behavior; neither runtime validation nor TypeScript provides a general type proof. Executing emitted JavaScript is the consumer's responsibility; a VM timeout is not a security sandbox for untrusted code.

## Example languages and capabilities

These are independent examples, not built-in modes of a single language. Their guides document syntax, limits, and commands.

| Guide | Demonstrated capabilities |
| --- | --- |
| [Toy](examples/toy/README.md) | Annotated functions, closures, checking, and core expression IR. |
| [HM](examples/hm/README.md) | Hindley–Milner inference. |
| [Rows](examples/rows/README.md) | HM with records, row polymorphism, strings, and local imports. |
| [Advanced](examples/advanced/README.md) | Data types, pattern matching, recursion, and higher-rank polymorphism. |
| [Strict](examples/strict/README.md) | Strict evaluation, algebraic data, classes, instances, and higher-kinded types. |
| [Ur core](examples/ur/README.md) | Explicit type/kind applications, disjoint records, and ordered folder traversal. |
| [Schema](examples/schema/README.md) | A separate checked schema-to-SQL compiler; it does not target expression IR. |
| [Shapes](examples/shapes/README.md) | Typed Lisp, unique-label row inference, structural requirements, updates, and checked macros. |

All eight have CLI and stdio language-server commands:

| Language | CLI | Language server | Neovim file extensions |
| --- | --- | --- | --- |
| Toy | `pnpm toy [file]` | `pnpm toy:lsp` | `.toy`, `.tpy` |
| HM | `pnpm hm [file]` | `pnpm hm:lsp` | `.hm` |
| Rows | `pnpm rows [file]` | `pnpm rows:lsp` | `.rows` |
| Advanced | `pnpm advanced [file]` | `pnpm advanced:lsp` | `.advanced` |
| Strict | `pnpm strict [file]` | `pnpm strict:lsp` | `.strict` |
| Ur | `pnpm ur [file]` | `pnpm ur:lsp` | `.ur` |
| Schema | `pnpm schema [file]` | `pnpm schema:lsp` | `.schema` |
| Shapes | `pnpm shapes [file]` | `pnpm shapes:lsp` | `.shapes` |

The project-local [`.nvim.lua`](.nvim.lua) registers all eight filetypes, LSP commands, and root selection; Neovim must be configured to trust/load project-local `exrc` files. Run each command from the repository root. Detailed examples and language-specific limits are in each linked guide.
