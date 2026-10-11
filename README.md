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

`createJudgments` dispatches exhaustive synthesis and checking rules over your own AST. `createBindings` coordinates declaration identity, lexical scopes, generalization, and reference instantiation. `createCompiler` publishes an emit-ready artifact only after clean finalization; failed or recovered work still exposes editor facts.

[Build a compiler with typed judgments](docs/compiler-authoring.md) has a complete caller example. The shared-syntax language runs polymorphic identity, row-polymorphic projection, and an explicitly annotated higher-rank parameter:

```sh
npm run mini -- hm 'let id = fn x => x; (id(1), id(true))'
npm run mini -- hm 'let getX = fn r => r.x; (getX({ x: 1, y: true }), getX({ x: true }))'
npm run mini -- higher-rank '(fn (f: forall a. a -> a) => (f(1), f(true)))(fn x => x)'
```

For host-known types, [host-typed staging](docs/staging.md) provides `Expr<A>`, typed functions and calls, declarations, and a local JavaScript emitter. Dynamic IR lowering uses `langkit/adapters/staging` and returns `Program<unknown>`. Both paths are self-contained.

## Compose an IR and backend

The IR is extensible and descriptor-driven. `create<T>()` supplies the small core; optional operation sets add methods and descriptors explicitly. A value carries the language's own type descriptor and the exact identity of its operation descriptor. The framework does not define the language's type system.

The standalone IR API is a generator-authored DSL. Pass a body generator to `body`, function, branch, or block builders. A body generator **yields declarations** through the generator's yield channel and **returns its final value** through its return channel. `declare` and `declareRecursive` are generators: use `yield*` to collect a declaration in the current body and receive its reference as the delegated generator's return value. Helper generators compose naturally with `yield*`; nested function and body callbacks can themselves be generators. Pure expressions remain ordinary direct builder calls.

This runnable TypeScript example builds one `Program` and emits it for both JavaScript and Python. Both generated programs compute and assert the same answer. The JavaScript example uses Node's VM for trusted demonstration code; the Python example executes generated source with `python3`.

```ts
import { create } from "langkit/ir";
import { createJavaScriptEmitter } from "langkit/javascript";
import { coreJavaScript } from "langkit/javascript/core";
import { recordsJavaScript } from "langkit/javascript/records";
import { records } from "langkit/operations/records";
import { createPythonEmitter } from "langkit/python";
import { corePython } from "langkit/python/core";
import { recordsPython } from "langkit/python/records";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

type Type = "number" | "function";
const recordFeature = records<Type>();
const code = create<Type>().use(recordFeature);
const jsEmitter = createJavaScriptEmitter(
  coreJavaScript(code.coreDescriptors),
  recordsJavaScript(recordFeature.descriptors),
);
const pythonEmitter = createPythonEmitter(
  corePython(code.coreDescriptors),
  recordsPython(recordFeature.descriptors),
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
const pySource = pythonEmitter.emit(program);
const pyRun = spawnSync("python3", [
  "-c",
  "import sys; ns = {}; exec(compile(sys.stdin.read(), '<langkit-program>', 'exec'), ns); print(ns['result'])",
], {
  input: pySource,
  encoding: "utf8",
});
if (pyRun.error) throw pyRun.error;
assert.equal(pyRun.status, 0, pyRun.stderr);
const pyAnswer = Number(pyRun.stdout.trim());
assert.equal(jsAnswer, 43);
assert.equal(pyAnswer, jsAnswer);
console.log(jsAnswer, pyAnswer); // 43 43
```

`conditional(type, condition, thenBody, elseBody)`, `block(type, body)`, and `scope(body)` likewise accept a `Body` or a generator callback. Function, branch, and block callbacks can capture their surrounding lexical bindings. A `Body<T>` is declarations plus a result value; declarations execute in order before the result. `declare` creates a fresh binding each time its generator runs. `declareRecursive(binding, functionValue)` keeps the supplied binding identity, yields a recursive declaration, and returns its reference; it accepts only a core function value.

For language authors adding an operation, keep the descriptor responsible for child order, scoped bodies and bindings, references, and immutable reconstruction. Here is the essential custom descriptor pattern; once the descriptor is installed on the builder, author expressions and bodies with the same generator DSL rather than assembling declaration arrays by hand:

```ts
import { create, type OperationNode, type Value } from "langkit/ir";
import { defineOperation } from "langkit/operations/descriptor";
import { defineDialect } from "langkit/operations/dialect";

type Type = "number";
type Twice = OperationNode & { readonly kind: "twice"; readonly value: Value<Type>; };
const twice = defineOperation<Type, Twice>("twice", {
  children: (node) => [node.value],
  scopedBodies: () => [],
  references: () => [],
  map: (node, mapValue) => ({ ...node, value: mapValue(node.value) }),
});
const code = create<Type>().use({
  ...defineDialect({ twice }),
  methods: {
    twice: (type: Type, value: Value<Type>) => twice.make(type, { kind: "twice", value }),
  },
});
const program = code.program(code.body(function*() {
  const input = yield* code.declare("input", code.literal("number", 21));
  return code.twice("number", input);
}));
```

Each selected descriptor owns child evaluation order, scoped bodies and bindings, references, and immutable reconstruction. Backend handlers are matched by exact descriptor identity, not by operation name. Emission validates the portable `Program<T>` and throws if a selected operation has no handler. A `Program<T>` supplies its body together with the builder's selected readonly operation registry and core function identity needed by standalone validation and backends. `validate(program)` checks structural scope and declaration invariants; it does not prove language-level typing. [Operation contracts and runtime representations](docs/operations.md) cover the complete API, mapper contract, and runtime representations.

### Integrating checking

The core IR DSL remains pure and does not require `Check`. Configure selected operation features on that builder first, then pass it to `elaboration(builder)` from `langkit/ir/check`. The adapter adds generator-factory entrypoints: `code.check(factory)` composes yielded `Check` computations and raw `Declaration` yields, `code.body(factory)` collects declarations into a checked body, and `code.scope(factory)` builds a checked block value. Factories have the mixed yield channel `Check<unknown> | Declaration<T>` and return their ordinary result. Use these factories—not Check-argument overloads—to bridge diagnostics into IR. Raw `declare` and `declareRecursive` remain pure generators that yield one declaration and return its reference; declaration yields require an enclosing `code.body` (or another body factory using the same adapter). Pure builder methods such as `fn`, `conditional`, `block`, and `scope` remain Check-free and accept a `Body` or pure body factory. `program(body)` validates immediately. Values retain their exact selected operation-descriptor identities, and lexical binding/reference relationships are preserved.

```ts
import { fail, run } from "langkit";
import { assign } from "langkit/inference";
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

`Check` failures are diagnostics; unexpected implementation exceptions propagate. `recover()` is for independent void checks: it records a diagnostic and continues, but `run` still returns failure when any recovered diagnostic exists. `Result<A>` is either `{ success: true, value: A }` or `{ success: false, errors: readonly [Diagnostic, ...Diagnostic[]] }`. Never emit a target program from a recovered-error result. `atomic()` restores run-local state on terminal failure or throw. `attempt(check)` also isolates and rolls back diagnostics recovered inside the attempt; `choice(...checks)` tries isolated alternatives and returns the first success, or the first failure if all fail. `sequence(tuple)` evaluates checks in order and returns the corresponding tuple of values. Each `run` has fresh state storage.

The state API separates mutable, checkpointable run-local values from immutable scoped environments: `state(init, checkpoint)` creates a `State` whose checkpoint callback returns a restore function; `scoped(initial)` creates a readonly `Scoped` binding. `get` reads either key. `within(key, update, body)` scopes an updated value only for the body, with `update` as the sole updater callback; `bind` extends a readonly map binding environment.

Inference computations allocate fresh variables, instantiate, and generalize inside the current run and are composed with `yield*` (or `map/flatMap`); do not nest `run` inside inference. `assign`, `add`, `put`, and `append` provide journaled writes to object properties, sets, maps, and arrays. Atomic rollback uses the journal, not deep snapshots at every solver step. `pruneLink(value, variable, instance)` is a three-argument, read-only link traversal; it does not compress or mutate links. The reusable checker/inference composition draws inspiration from typerator's transactional state and recovery model and ts-macros-style generator IR, without imposing TypeScript-specific syntax or type ontology on a language implementation.

### JavaScript and Python backends

Consumers choose an emitter for the same portable `Program<T>` by composing the matching core and selected feature handler sets. `langkit/javascript` and `langkit/python` are Node package modules; Python source is generated by TypeScript code and does not make Python a prerequisite for installing or using the Node library. A consumer that executes emitted Python needs Python 3 on its PATH. Cross-target tests also execute generated Python and therefore require `python3`. The existing example-language CLIs remain their own tools; this does not add Python flags or imply a Python backend in those CLIs.

Python's printing operation uses native Python representation rather than JavaScript console formatting. The cross-target contract covers type-correct arithmetic and field access, not general language type safety; typing remains the language author's responsibility. JavaScript execution is likewise the consumer's responsibility: a VM timeout is not a security sandbox for untrusted code.

## Optional tools

- **Parsing:** `langkit/parse` re-exports parserator parsers, generators, precedence, cuts, and source locations.
- **Checking and diagnostics:** `langkit` provides synchronous `Check` computations, checkpointable run-local `State`, readonly scoped environments, atomic/attempt/choice rollback, recoverable independent diagnostics, and structured nonempty `Result.errors`. `Check.inDocument(uri)` optionally attaches a document identity to failures for module routing while preserving nested source origins; human-readable `context` labels are not machine source locations.
- **Inference:** `langkit/types/hm`, `langkit/types/rows`, and `langkit/types/higher-rank` provide reusable theories. `langkit/inference` provides journaled mutation for other theories. [Inference theory contracts](docs/inference-theories.md) define the grammars and limits.
- **Syntax:** `langkit/syntax` derives recursive AST types, constructors, immutable mappers, and explicit binder-aware traversal. It does not define a parser or typing rules. [Syntax declarations](docs/syntax.md) describe the optional schema.
- **Modules:** `langkit/modules` provides a local-file module graph/loader for languages that want imports; it is optional. Analyses can include transitive dependency URIs and source snapshots.
- **Analysis and editor support:** `langkit/analysis` optionally collects UTF-16 source ranges for types, definitions, references, lexical tokens, and diagnostics. `langkit/lsp` serves language-provided analysis over LSP, including dependency-aware re-analysis when imported documents change. Diagnostics retain structured source locations and related information for imported-source errors.
- **JavaScript:** `langkit/javascript` validates and emits an expression using explicitly composed handlers. Feature handler sets must use the same operation descriptor instances as the IR builder. Emission is not a source-map generator.
- **Python:** `langkit/python` emits executable Python source using explicitly composed handlers. Feature handler sets must use the same operation descriptor instances as the IR builder.

The core IR's scope validation and the language's type checker have different responsibilities. Constructors trust the language's typing rules; neither runtime validation nor TypeScript provides a general type proof.

[Verification contracts](docs/verification.md) cover runtime tests, compiler fixtures, real TypeScript editor probes, isolated `any` and `never` controls, and compiler-cost measurements.

## Example languages and capabilities

These are independent examples, not built-in modes of a single language. Their guides document syntax, limits, and commands.

| Guide                                   | Demonstrated capabilities                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Toy](examples/toy/README.md)           | Annotated functions, closures, checking, and core expression IR.                              |
| [HM](examples/hm/README.md)             | Hindley–Milner inference.                                                                     |
| [Rows](examples/rows/README.md)         | HM with records, row polymorphism, strings, and local imports.                                |
| [Advanced](examples/advanced/README.md) | Data types, pattern matching, recursion, and higher-rank polymorphism.                        |
| [Strict](examples/strict/README.md)     | Strict evaluation, algebraic data, classes, instances, and higher-kinded types.               |
| [Ur core](examples/ur/README.md)        | Explicit type/kind applications, disjoint records, and ordered folder traversal.              |
| [Schema](examples/schema/README.md)     | A separate checked schema-to-SQL compiler; it does not target expression IR.                  |
| [Shapes](examples/shapes/README.md)     | Typed Lisp, unique-label row inference, structural requirements, updates, and checked macros. |

All eight have CLI and stdio language-server commands:

| Language | CLI                    | Language server     | Neovim file extensions |
| -------- | ---------------------- | ------------------- | ---------------------- |
| Toy      | `pnpm toy [file]`      | `pnpm toy:lsp`      | `.toy`, `.tpy`         |
| HM       | `pnpm hm [file]`       | `pnpm hm:lsp`       | `.hm`                  |
| Rows     | `pnpm rows [file]`     | `pnpm rows:lsp`     | `.rows`                |
| Advanced | `pnpm advanced [file]` | `pnpm advanced:lsp` | `.advanced`            |
| Strict   | `pnpm strict [file]`   | `pnpm strict:lsp`   | `.strict`              |
| Ur       | `pnpm ur [file]`       | `pnpm ur:lsp`       | `.ur`                  |
| Schema   | `pnpm schema [file]`   | `pnpm schema:lsp`   | `.schema`              |
| Shapes   | `pnpm shapes [file]`   | `pnpm shapes:lsp`   | `.shapes`              |

The project-local [`.nvim.lua`](.nvim.lua) registers all eight filetypes, LSP commands, and root selection; Neovim must be configured to trust/load project-local `exrc` files. Run each command from the repository root. Detailed examples and language-specific limits are in each linked guide.
