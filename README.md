# langkit

Langkit is a TypeScript toolkit for building language-specific parsers, checkers, intermediate representations, backends, analyzers, and language servers. These are cooperating pieces, not a required compiler pipeline: there is no mandatory language object, type ontology, or lowering sequence. A language chooses the pieces and invariants it needs.

Requires Node.js 24.2+ and pnpm.

```sh
pnpm install
pnpm toy examples/toy/main.toy
pnpm typecheck
pnpm test
```

## Author typing rules

Write the checker as a `switch` over your own AST inside a `check` generator. `bind` and `lookup` manage lexical scopes, and the higher-rank theory supplies `generalize` and `instantiate`.

## Build IR and emit JavaScript

The IR is a closed tagged union, `Value<T>`, where `T` is your language's type. `langkit/ir` exports one constructor per node kind. `declare` is a `Check` that adds a declaration to the enclosing `body` and returns a reference to it, so declarations and diagnostics share one `check` generator. `emit(body)` from `langkit/javascript` turns a `Body<T>` into one JavaScript expression.

```ts
import { check, fail, run } from "langkit";
import * as ir from "langkit/ir";
import { emit } from "langkit/javascript";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Type = "number" | "function";
const number = (n: number) => ir.literal<Type>("number", n);

const argument = ir.binding<Type>("argument", "number");
const increment = ir.fn<Type>("function", argument, {
  declarations: [],
  result: ir.binary("number", "+", ir.ref(argument), number(1)),
});
const program = ir.body(check(function*() {
  const left = yield* ir.declare("left", number(19));
  const right = yield* ir.declare("right", number(23));
  const addOne = yield* ir.declare("addOne", increment);
  return ir.call<Type>("number", addOne, ir.binary("number", "+", left, right));
}));

const built = run(program);
assert(built.success);
assert.equal(runInNewContext(emit(built.value)), 43);

const failed = run(ir.body(check(function*() {
  yield* fail("independent constraint failed").recover();
  return yield* ir.declare("answer", number(42));
})));
assert(!failed.success); // recovered diagnostics still fail the run, so nothing is emitted
```

`declareRecursive(binding, fn)` keeps the binding you pass, so the function can call itself. `scope(check)` wraps a body in a block value. The IR trusts your checker: it does not re-check scope or types.

## Checking

`Check` failures are diagnostics; unexpected implementation exceptions propagate. `recover()` is for independent void checks: it records a diagnostic and continues, but `run` still returns failure when any recovered diagnostic exists. `Result<A>` is either `{ success: true, value: A }` or `{ success: false, errors: readonly [Diagnostic, ...Diagnostic[]] }`. Never emit a target program from a recovered-error result. `atomic()` restores run-local state on terminal failure or throw. Each `run` has fresh state storage.

```ts
import { assign, fail, run } from "langkit";

const cell = { value: 0 };
const rolledBack = run(assign(cell, "value", 1).flatMap(() => fail("constraint conflict")).atomic());
if (rolledBack.success || cell.value !== 0) throw new Error("atomic rollback failed");
```

The state API separates mutable, checkpointable run-local values from immutable scoped environments: `state(init, checkpoint)` creates a `State` whose checkpoint callback returns a restore function; `scoped(initial)` creates a readonly `Scoped` binding. `get` reads either key. `within(key, update, body)` scopes an updated value only for the body, with `update` as the sole updater callback; `bind` extends a readonly map binding environment.

Inference computations allocate fresh variables, instantiate, and generalize inside the current run and are composed with `yield*` (or `map/flatMap`); do not nest `run` inside inference. `assign` and `add` provide journaled writes to object properties and sets. Atomic rollback uses the journal, not deep snapshots at every solver step. `pruneLink(value, variable, instance)` is a three-argument, read-only link traversal; it does not compress or mutate links. The reusable checker/inference composition draws inspiration from typerator's transactional state and recovery model and ts-macros-style generator IR, without imposing TypeScript-specific syntax or type ontology on a language implementation.

## Optional tools

- **Parsing:** `langkit/parse` re-exports parserator parsers, generators, precedence, cuts, and source locations.
- **Checking and diagnostics:** `langkit` provides synchronous `Check` computations, checkpointable run-local `State`, readonly scoped environments, atomic rollback, recoverable independent diagnostics, and structured nonempty `Result.errors`. `Check.inDocument(uri)` optionally attaches a document identity to failures for module routing while preserving nested source origins; human-readable `context` labels are not machine source locations.
- **Inference:** `langkit/types/higher-rank` provides a reusable theory, and `assign`, `add`, and `push` from `langkit` provide journaled mutation for others.
- **Modules:** [`advanced-modules.ts`](examples/advanced/advanced-modules.ts) shows a local-file module graph/loader for languages that want imports. Analyses can include transitive dependency URIs and source snapshots.
- **Analysis and editor support:** `langkit/analysis` optionally collects UTF-16 source ranges for types, definitions, references, lexical tokens, and diagnostics. `langkit/lsp` serves language-provided analysis over LSP, including dependency-aware re-analysis when imported documents change. Diagnostics retain structured source locations and related information for imported-source errors.
- **JavaScript:** `langkit/javascript` emits a body as one JavaScript expression. Emission is not a source-map generator. Executing the emitted code is the consumer's responsibility: a VM timeout is not a security sandbox for untrusted code.

Verification covers runtime tests, compiler fixtures, real TypeScript editor probes, isolated `any` and `never` controls, and compiler-cost measurements.

## Example languages and capabilities

These are independent examples, not built-in modes of a single language. Their guides document syntax, limits, and commands.

| Guide                                   | Demonstrated capabilities                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| [Toy](examples/toy/README.md)           | Annotated functions, closures, checking, and core expression IR.             |
| [HM](examples/hm/README.md)             | Hindley–Milner inference.                                                    |
| [Advanced](examples/advanced/README.md) | Data types, pattern matching, recursion, and higher-rank polymorphism.       |
| [Schema](examples/schema/README.md)     | A separate checked schema-to-SQL compiler; it does not target expression IR. |

All four have CLI and stdio language-server commands:

| Language | CLI                    | Language server     | Neovim file extensions |
| -------- | ---------------------- | ------------------- | ---------------------- |
| Toy      | `pnpm toy [file]`      | `pnpm toy:lsp`      | `.toy`                 |
| HM       | `pnpm hm [file]`       | `pnpm hm:lsp`       | `.hm`                  |
| Advanced | `pnpm advanced [file]` | `pnpm advanced:lsp` | `.advanced`            |
| Schema   | `pnpm schema [file]`   | `pnpm schema:lsp`   | `.schema`              |

The project-local [`.nvim.lua`](.nvim.lua) registers all four filetypes, LSP commands, and root selection; Neovim must be configured to trust/load project-local `exrc` files. Run each command from the repository root. Detailed examples and language-specific limits are in each linked guide.
