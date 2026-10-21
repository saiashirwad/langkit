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

The IR is a closed tagged union, `Value<T>`, where `T` is your language's type. `create<T>()` gives constructors for every node kind. A body generator yields declarations with `yield* code.declare(...)` and returns its result. `emit(body)` from `langkit/javascript` turns a `Body<T>` into one JavaScript expression.

```ts
import { create } from "langkit/ir";
import { emit } from "langkit/javascript";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Type = "number" | "function";
const code = create<Type>();
const number = (n: number) => code.literal("number", n);

const argument = code.binding("argument", "number");
const increment = code.fn("function", argument, function*() {
  return code.binary("number", "+", code.ref(argument), number(1));
});
const body = code.body(function*() {
  const left = yield* code.declare("left", number(19));
  const right = yield* code.declare("right", number(23));
  const addOne = yield* code.declare("addOne", increment);
  return code.call("number", addOne, code.binary("number", "+", left, right));
});

assert.equal(runInNewContext(emit(body)), 43);
```

`declareRecursive(binding, fn)` keeps the binding you pass, so the function can call itself. The IR trusts your checker: it does not re-check scope or types.

### Integrating checking

The core IR DSL remains pure and does not require `Check`. Pass the builder to `elaboration(builder)` from `langkit/ir/check`. The adapter adds generator-factory entrypoints: `code.check(factory)` composes yielded `Check` computations and raw `Declaration` yields, `code.body(factory)` collects declarations into a checked body, and `code.scope(factory)` builds a checked block value. Factories have the mixed yield channel `Check<unknown> | Declaration<T>` and return their ordinary result. Use these factories—not Check-argument overloads—to bridge diagnostics into IR. Raw `declare` and `declareRecursive` remain pure generators that yield one declaration and return its reference; declaration yields require an enclosing `code.body` (or another body factory using the same adapter). Pure builder methods such as `fn`, `conditional`, `block`, and `scope` remain Check-free and accept a `Body` or pure body factory.

```ts
import { fail, run } from "langkit";
import { assign } from "langkit";
import { create } from "langkit/ir";
import { elaboration } from "langkit/ir/check";

type Type = "number";
const code = elaboration(create<Type>());
const bodyResult = run(code.body(function*() {
  const result = yield* code.check(function*() {
    yield* fail("independent constraint failed").map(() => undefined).recover();
    return code.literal("number", 42);
  });
  const answer = yield* code.declare("answer", result);
  return answer;
}));

if (bodyResult.success) {
  // Emit only this success branch; recovered diagnostics make run() fail.
  void bodyResult.value;
} else {
  console.error(bodyResult.errors); // nonempty structured diagnostics
}

const cell = { value: 0 };
const transaction = assign(cell, "value", 1).flatMap(() => fail("constraint conflict")).atomic();
const rolledBack = run(transaction);
if (rolledBack.success || cell.value !== 0) throw new Error("atomic rollback failed");
```

`Check` failures are diagnostics; unexpected implementation exceptions propagate. `recover()` is for independent void checks: it records a diagnostic and continues, but `run` still returns failure when any recovered diagnostic exists. `Result<A>` is either `{ success: true, value: A }` or `{ success: false, errors: readonly [Diagnostic, ...Diagnostic[]] }`. Never emit a target program from a recovered-error result. `atomic()` restores run-local state on terminal failure or throw. Each `run` has fresh state storage.

The state API separates mutable, checkpointable run-local values from immutable scoped environments: `state(init, checkpoint)` creates a `State` whose checkpoint callback returns a restore function; `scoped(initial)` creates a readonly `Scoped` binding. `get` reads either key. `within(key, update, body)` scopes an updated value only for the body, with `update` as the sole updater callback; `bind` extends a readonly map binding environment.

Inference computations allocate fresh variables, instantiate, and generalize inside the current run and are composed with `yield*` (or `map/flatMap`); do not nest `run` inside inference. `assign` and `add` provide journaled writes to object properties and sets. Atomic rollback uses the journal, not deep snapshots at every solver step. `pruneLink(value, variable, instance)` is a three-argument, read-only link traversal; it does not compress or mutate links. The reusable checker/inference composition draws inspiration from typerator's transactional state and recovery model and ts-macros-style generator IR, without imposing TypeScript-specific syntax or type ontology on a language implementation.

## Optional tools

- **Parsing:** `langkit/parse` re-exports parserator parsers, generators, precedence, cuts, and source locations.
- **Checking and diagnostics:** `langkit` provides synchronous `Check` computations, checkpointable run-local `State`, readonly scoped environments, atomic rollback, recoverable independent diagnostics, and structured nonempty `Result.errors`. `Check.inDocument(uri)` optionally attaches a document identity to failures for module routing while preserving nested source origins; human-readable `context` labels are not machine source locations.
- **Inference:** `langkit/types/higher-rank` provides a reusable theory, and `assign`, `add`, and `push` from `langkit` provide journaled mutation for others.
- **Modules:** `langkit/modules` provides a local-file module graph/loader for languages that want imports; it is optional. Analyses can include transitive dependency URIs and source snapshots.
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
