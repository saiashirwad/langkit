# Verification contracts

Langkit checks runtime behavior, TypeScript callers, actual editor responses, and compiler cost separately. A passing runtime suite does not establish a TypeScript inference guarantee, and a compiler success does not establish emitted behavior.

## Runtime and compiler callers

```sh
npm test
npm run typecheck
npm run fmt:check
```

The runtime suite includes representative source programs for the example languages and focused checking, scope, solver, source-analysis, and emission regressions. Duplicate legacy syntax and constructor assertions are not completion requirements.

TypeScript compiles source, examples, tools, and compile-time fixtures under the same strict configuration. Positive proofs assert exact types and reject `any` and `never`. `@ts-expect-error` marks calls that must remain invalid, including omitted backend handlers and incorrect callback nodes.

`tests/documentation.test.ts` compiles and executes the complete TypeScript examples in the README and the inference and compiler-authoring guides. The examples run in temporary copies of the source package.

`npm run fmt` formats code and documentation with the pinned `dprint` and plugin versions. Its configuration excludes `future.md` and dependency directories. `npm run fmt:check` checks the same files without changing them.

## Isolated mutation controls

```sh
npm run type:contracts
```

`tools/type-contracts.ts` copies the source package into a temporary project and resolves the existing dependencies. It first requires a clean consumer compilation.

Six controls replace a literal `yield*` result, a synthesized judgment result, or a staged output with `any` and then `never`. Each compilation must fail at the exact-result proof and the matching anti-degradation proof. The tool rejects extra diagnostics, missing-file errors, and resolution failures. Cleanup removes only its own temporary directory.

These controls prove that the selected assertions detect degraded inference. They do not mutate every exported type or prove the soundness of a solver.

## Real editor responses

```sh
npm run editor:check
```

`tools/editor-check.ts` starts the installed TypeScript 7 LSP server over standard input and output. `tests/editor-consumer.ts` is the source document. `tools/editor-contracts.ts` defines exact probe anchors and response requirements.

The probes check callback types, judgment results, staged parameters and outputs, literal results, sequence tuples, named values, completions, and active signature arguments. Hover and signature text have length bounds and must not contain degraded types or truncation.

The gate requires clean corpus diagnostics and compares responses against `tests/editor-consumer.snapshot.json`. It then changes the in-memory document to the `any` and `never` mutants, observes their actual hover text, rejects them, and confirms restoration. It does not edit the source document.

To accept a deliberate editor change, inspect the responses before committing an updated snapshot:

```sh
npm run editor:update -- --inspect
npm run editor:check
```

## Compiler cost

```sh
npm run type:profile
```

`tools/type-profile.ts` profiles the main project and generated consumers with 10, 50, and 200 distinct cases. Generated consumers exercise contextual descriptor callbacks, heterogeneous judgment rules, typed staged arrows and declarations, exact-type proofs, and literal sequence tuples.

Each workload runs in a new compiler process three times by default. The report includes medians for types, instantiations, check time, total time, and memory. The deterministic gate permits at most 500,000 types and 2,000,000 instantiations per workload. Timing and memory are reported, not gated.

An optional JSON file retains raw diagnostics, compiler version, configuration, source hashes, lockfile hash, revision, and units:

```sh
npm run type:profile -- --samples 3 --output /path/to/profile.json
```

## Verified integration

The formatted implementation at `0430421` passes 242 runtime tests, TypeScript checking, 25 real LSP probes, six exact compiler mutation controls, and ten local staging integration checks. `dprint` checks the complete code and guides. The three shared-syntax programs in the compiler-authoring guide execute to their expected results.

The compiler profile uses TypeScript 7.0.2 and Node 24.21.0, with three cold samples per workload. Deterministic counts are below the configured bounds:

| Workload                                   |   Types | Instantiations |
| ------------------------------------------ | ------: | -------------: |
| Main project                               | 160,139 |        257,522 |
| 10 descriptor, judgment, and staging cases |  95,277 |        133,003 |
| 50 cases                                   | 101,292 |        156,847 |
| 200 cases                                  | 123,934 |        303,297 |

The profiled TypeScript source hash is `b1c213e1416ff5996f3315b1461a0b00297da5e5caebfd4022b0468ae8cdb3f3`. Run the commands above to measure a later revision. These results establish the tested contracts, not a universal solver soundness proof.
