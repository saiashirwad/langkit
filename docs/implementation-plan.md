# Typed elaboration implementation plan

The target is a reusable language-authoring layer between `Check` and a complete compiler. Existing IR, parsing, and analysis tools remain independently usable. Semantic types remain runtime data owned by each type system.

## Completion gates

- Reusing a checked body creates distinct declaration collections and binding identities.
- Deep `flatMap`, generator, scope, and transaction composition does not overflow the JavaScript stack.
- Typed dialects derive exhaustive backend handlers without repeated operation node definitions. Runtime descriptor identity checks still reject foreign operations.
- HM and row inference live in supported library modules. Representative languages use them without copied unifiers or generalizers.
- Exhaustive synthesis/checking tables narrow AST nodes in callbacks. Checking-only and unsupported cases are explicit. Rules coordinate source locations, analysis facts, and binding scopes.
- Higher-rank checking has an explicit predicative contract and adversarial scope-escape tests. Documentation distinguishes implementation guarantees from a proof of a published calculus.
- Finalization separates emit-ready artifacts from partial elaboration. Diagnostics and editor facts remain available after recovery.
- The compact language exercises functions, let polymorphism, records, projection, annotations, and pairs. Runtime execution agrees with the inferred types.
- Runtime, compile-time, editor, and negative-control tests pass on the integrated branch.

## Task list

- [x] Read `poteto-mode` Principles and applicable leaf skills.
- [x] Capture the baseline on this branch: `npm test` passes 1,214 tests; `npm run typecheck` passes.
- [x] Reproduce both reported runtime defects directly.
- [x] Ground the runtime, descriptors, inference, and historical constraints through read-only exploration.
- [x] Sketch two distinct authoring designs in isolated locations.
- [x] Cross-judge the sketches, choose a base, and record the signatures and rationale.
- [x] Agree: automatic continuation, as the user requested autonomous implementation.
- [x] Checkpoint: run blocking architecture and baseline gates before authoring implementation fan-out.
- [x] Checkpoint: assign the grounded runtime, descriptor, solver, and module-loader workstreams. Judgment and tooling work wait for the authoring design.
- [x] Checkpoint: give every writable worker a separate worktree; serialize integration here.
- [x] Checkpoint: use the smallest unit that can be verified, then integrate it before building dependents.
- [x] Harden the runtime. Add failing tests, trace their cause, implement the machine, and rerun the original probes.
- [x] Preserve descriptor types and migrate backend definitions to derived handler types.
- [x] Extract HM and rows; remove the migrated examples' duplicate solver machinery.
- [x] Introduce judgments and binder combinators; migrate representative rules.
- [x] Establish reusable higher-rank checking. Its conformance tests pass; publish its grammar, annotation policy, and limitations with the authoring guide.
- [x] Add partial/finalized elaboration and structured rule/constraint evidence.
- [x] Separate module graph management from import parsing through a language-supplied parser.
- [x] Add the shared-syntax language demonstration and a supported staged-construction adapter.
- [x] Verify optional syntax declarations and the constructor adapter against the actual TS Macros reference.
- [x] Make staged construction, lowering, and execution self-contained. The user clarified that TS Macros is not an npm dependency.
- [x] Add compile-time, editor, mutation-control, and compiler-cost checks.
- [x] Replace the injected external target with local constructors, witnesses, and emission; delete the old entrypoints.
- [ ] Inspect the scoped diff with `no-comments`; retain only comments for external constraints and compiler test directives.
- [ ] Review the complete artifacts and decision trail with an independent read-only reviewer. Foundation review reproduced two descriptor defects; both now have passing regressions.
- [ ] Run the full completion gates on this branch and record exact outcomes.
- [ ] Prune duplicate legacy tests and retain representative source-to-compilation programs, as the user requested.
- [ ] Format all code with pinned dprint, then rerun the completion gates.
- [ ] Commit and push this branch, as the user explicitly requested during integration.
- [x] Opening a PR: skipped because the user requested a push, not a PR.

## Phase ownership and checks

| Phase | Owned files | Dependencies | Smallest unit and check | Stop condition |
| --- | --- | --- | --- | --- |
| Runtime | `src/check.ts`, `src/ir/check.ts`, runtime regression tests | Baseline and execution sketch | Regression tests, then machine. `node --test tests/check.test.ts tests/generator-ir.test.ts tests/composition.test.ts` and `npm run typecheck` | A transaction, exception, or cleanup contract regresses |
| Descriptors | `src/operations`, backend handler modules, dialect tests | Descriptor sketch | Typed records, then backend migration. Descriptor tests, cross-target tests, and TypeScript | Exact runtime identities or static handler coverage are lost |
| Solvers | `src/types`, solver tests, migrated example solver code | Solver grammar and mutation contract | Extract each implementation and verify its existing conformance tests | An old success fails or an old rejection becomes accepted |
| Judgments | `src/judgments.ts`, judgment tests, representative language rules | Rule sketch, then extracted solvers for migration | Registry and binder coordination, then migration. TypeScript and source-to-execution tests | Rules need hidden language-specific state in the framework |
| Tooling | Finalization, trace/evidence, module parser boundary, `tools`, editor corpus, adapter | Stable judgment and dialect contracts | One observable capability per test, then editor checks | Recovered artifacts become emit-ready or checks miss their negative controls |
| Integration | Exports, scripts, guides, decision trail | Verified workstream commits | `npm test`, `npm run typecheck`, editor checks, controls, and showcase execution | Any gate fails or cannot observe the promised behavior |

The user authorized committing and pushing `feat/composable-language-tools` to its existing origin. No PR, merge, or deployment is requested. Langkit remains the owner of the checking runtime in this repository. Typerator is a semantic reference, not a second implementation to update here.

API compatibility is not a goal. The user confirmed that this is greenfield. Existing languages are semantic conformance cases, not a reason to retain an obsolete authoring interface.

Historical constraints come from `83a8999`, `990a5be`, `8fd2075`, and `04bb9b4`. They explicitly preserve component independence, exact descriptor identities, instantiated reference types, transactional inference, and partial editor facts. Other historical systems were not available through MCP in this session.
