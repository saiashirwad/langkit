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

`createJudgments` dispatches exhaustive synthesis and checking rules over your own AST. `createBindings` coordinates declaration identity, lexical scopes, generalization, and reference instantiation.

[Build a compiler with typed judgments](docs/compiler-authoring.md) has a complete caller example.

## Compose an IR and backend

The IR is extensible and descriptor-driven. `create<T>()` supplies the small core; optional operation sets add methods and descriptors explicitly. A value carries the language's own type descriptor and the exact identity of its operation descriptor. The framework does not define the language's type system.

The standalone IR API is a generator-authored DSL. Pass a body generator to `body`, function, branch, or block builders. A body generator **yields declarations** through the generator's yield channel and **returns its final value** through its return channel. `declare` and `declareRecursive` are generators: use `yield*` to collect a declaration in the current body and receive its reference as the delegated generator's return value. Helper generators compose naturally with `yield*`; nested function and body callbacks can themselves be generators. Pure expressions remain ordinary direct builder calls.

This runnable TypeScript example builds one `Program`, emits JavaScript, and runs it in Node's VM as trusted demonstration code.

```ts
import { create } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { recordsJavaScript } from "langkit/javascript/records";
import { records } from "langkit/operations/records";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

type Type = "number" | "function";
const recordFeature = records<Type>();
const code = create<Type>().use(recordFeature);
const jsEmitter = createJavaScriptEmitter(
  coreJavaScript(code.coreDescriptors),
  recordsJavaScript(recordFeature.descriptors),
);
const number = (n: number) => code.literal("number", n);

function* additions() {
  const left = yield* code.declare("left", number(19));
  const right = yield* code.declare("right", number(23));
  return code.binary("number", "+", left, right);
}

const argument = code.binding("argument", "number");
const increment = code.fn("function", argument, function*() {
  return code.binary("number", "+", code.ref(argument), number(1));
});
const program = code.program(code.body(function*() {
  const sum = yield* additions();
  const addOne = yield* code.declare("addOne", increment);
  return code.call("number", addOne, sum);
}));

const jsAnswer = runInNewContext(jsEmitter.emit(program));
assert.equal(jsAnswer, 43);
console.log(jsAnswer); // 43
```

`conditional(type, condition, thenBody, elseBody)`, `block(type, body)`, and `scope(body)` likewise accept a `Body` or a generator callback. Function, branch, and block callbacks can capture their surrounding lexical bindings. A `Body<T>` is declarations plus a result value; declarations execute in order before the result. `declare` creates a fresh binding each time its generator runs. `declareRecursive(binding, functionValue)` keeps the supplied binding identity, yields a recursive declaration, and returns its reference; it accepts only a core function value.

For language authors adding an operation, keep the descriptor responsible for child order, scoped bodies and bindings, and references. Here is the essential custom descriptor pattern; once the descriptor is installed on the builder, author expressions and bodies with the same generator DSL rather than assembling declaration arrays by hand:

```ts
import { create, type OperationNode, type Value } from "langkit/ir";
import { defineOperation } from "langkit/operations/descriptor";

type Type = "number";
type Twice = OperationNode & { readonly kind: "twice"; readonly value: Value<Type>; };
const twice = defineOperation<Type, Twice>("twice", {
  children: (node) => [node.value],
});
const code = create<Type>().use({
  descriptors: { twice },
  methods: {
    twice: (type: Type, value: Value<Type>) => twice.make(type, { kind: "twice", value }),
  },
});
const program = code.program(code.body(function*() {
  const input = yield* code.declare("input", code.literal("number", 21));
  return code.twice("number", input);
}));
```

Each selected descriptor owns child evaluation order, scoped bodies and bindings, and references. Backend handlers are matched by exact descriptor identity, not by operation name. Emission validates the portable `Program<T>` and throws if a selected operation has no handler. A `Program<T>` supplies its body together with the builder's selected readonly operation registry and core function identity needed by standalone validation and backends. `validate(program)` checks structural scope and declaration invariants; it does not prove language-level typing. [Operation contracts and runtime representations](docs/operations.md) cover the complete API and runtime representations.

### Integrating checking

The core IR DSL remains pure and does not require `Check`. Configure selected operation features on that builder first, then pass it to `elaboration(builder)` from `langkit/ir/check`. The adapter adds generator-factory entrypoints: `code.check(factory)` composes yielded `Check` computations and raw `Declaration` yields, `code.body(factory)` collects declarations into a checked body, and `code.scope(factory)` builds a checked block value. Factories have the mixed yield channel `Check<unknown> | Declaration<T>` and return their ordinary result. Use these factories—not Check-argument overloads—to bridge diagnostics into IR. Raw `declare` and `declareRecursive` remain pure generators that yield one declaration and return its reference; declaration yields require an enclosing `code.body` (or another body factory using the same adapter). Pure builder methods such as `fn`, `conditional`, `block`, and `scope` remain Check-free and accept a `Body` or pure body factory. `program(body)` validates immediately. Values retain their exact selected operation-descriptor identities, and lexical binding/reference relationships are preserved.

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
  const program = code.program(bodyResult.value); // validates now
  // Emit only this success branch; recovered diagnostics make run() fail.
  void program;
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
- **Inference:** `langkit/types/higher-rank` provides a reusable theory, and `assign`, `add`, and `push` from `langkit` provide journaled mutation for others. [Inference theory contracts](docs/inference-theories.md) define the grammars and limits.
- **Modules:** `langkit/modules` provides a local-file module graph/loader for languages that want imports; it is optional. Analyses can include transitive dependency URIs and source snapshots.
- **Analysis and editor support:** `langkit/analysis` optionally collects UTF-16 source ranges for types, definitions, references, lexical tokens, and diagnostics. `langkit/lsp` serves language-provided analysis over LSP, including dependency-aware re-analysis when imported documents change. Diagnostics retain structured source locations and related information for imported-source errors.
- **JavaScript:** `langkit/javascript` validates and emits an expression using explicitly composed handlers. Feature handler sets must use the same operation descriptor instances as the IR builder. Emission is not a source-map generator. Executing the emitted code is the consumer's responsibility: a VM timeout is not a security sandbox for untrusted code.

The core IR's scope validation and the language's type checker have different responsibilities. Constructors trust the language's typing rules; neither runtime validation nor TypeScript provides a general type proof.

[Verification contracts](docs/verification.md) cover runtime tests, compiler fixtures, real TypeScript editor probes, isolated `any` and `never` controls, and compiler-cost measurements.

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
