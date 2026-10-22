# Changelog

## Unreleased (breaking)

langkit now hosts small languages inside TypeScript. TypeScript 7.1 content mappers get types from your checker, and a node loader runs the emitted JavaScript.

### Added

- `langkit/host`: `HostLanguage`, projection pieces (`atom`, `verbatim`, `project`), `serveContentMapper` and `registerHostLanguages`.
- The IR emits ES modules with imports and exports (`emitModule`).
- `transaction((tx) => ...)` for journaled writes. A throw undoes the transaction's writes, and `tx.fail(message)` becomes a check failure.
- `langkit/types/typescript` prints inferred types as TypeScript. `langkit/parse` adds `named` and `located`.
- Hosted examples: Toy, HM, Schema (SQLite queries and a runtime), Domain (types, state machines and systems, with a model checker), Advanced (data types, higher-rank types, imports across files), and Grammar (a parser generator whose `.grammar` files give TypeScript a parser and the AST types it returns).
- Reactor, a hosted example for state machines whose state is data: cells rewritten by first-match rows, signals, and list bounds checked against the rows above, with `..` to carry a list's rest through a row unnamed. TypeScript imports a machine as frozen values with one method per input, its bounded lists typed as tuples, and a JSON snapshot that `parse` reads back. `pnpm reactor` and `pnpm reactor:lsp`.

### Changed

- `declare` is a `Check`. The IR is one closed node union with one JavaScript emitter.
- `fresh`, `freshRow`, `instantiate`, `instantiateForall`, `skolemize` and `generalize` are plain functions. `unify`, `exclude`, `subsume` and `expectFunction` stay `Check`s.
- `row(fields, tail)` throws unless the tail lacks the row's labels.
- parserator 0.4.0. Checking `examples/advanced/main.advanced` went from 7.4 ms to 2.8 ms.

### Removed

- `assign`, `add` and `push`. Use `transaction`.
- `attempt`, `choice` and `sequence`.
- The Python backend, operation dialects, staging, judgments, bindings, the elaboration wrapper, `langkit/types/hm`, `langkit/types/rows` and `pruneLink`.
- `docs/` and the per-language READMEs. The README is the guide.
