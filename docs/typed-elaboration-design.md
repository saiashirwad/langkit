# Typed elaboration design

Language authors bring an ordinary discriminated-union AST, a parser, semantic types, and a term representation. Langkit supplies typed rule dispatch, coordinated bindings, supported inference theories, diagnostics, observations, and a clean finalization boundary. None of these requires expression IR.

## Authoring contract

The public judgment result is small:

```ts
interface Synthesized<Type, Term> {
  readonly type: Type;
  readonly term: Term;
}

interface Judgments<Node, Type, Term> {
  synth(node: Node): Check<Synthesized<Type, Term>>;
  check(node: Node, expected: Type): Check<Term>;
}
```

A rule table contains one entry per AST kind. Each callback receives `Extract<Node, { kind: Kind }>`, not the entire union. Synthesis, checking-only forms, and unsupported forms are explicit. Checking uses a specialized callback or an explicit synthesis-through-acceptance fallback.

The checking contract separates entry from acceptance. A higher-rank theory can open an expected quantifier before a lambda rule runs. A fallback can synthesize, then apply the theory's subsumption judgment. Equality and subsumption are not interchangeable.

```ts
interface CheckingModes<Type, Term> {
  enter(expected: Type, body: (opened: Type) => Check<Term>): Check<Term>;
  accept(actual: Synthesized<Type, Term>, expected: Type): Check<Term>;
}
```

Rules receive configured functions and objects. TypeScript verifies those concrete dependencies. The runtime does not claim to discover arbitrary JavaScript effects or infer a service requirement from a captured global. `Check<A>` stays readable rather than gaining capability rows before a consumer case justifies them.

## Binding contract

Bindings have declaration identities independent of spelling. Schemes belong to declarations; fresh instantiated types belong to uses. A polymorphic reference can therefore retain one binding identity while its type differs at each use.

Binding helpers own identity allocation, lexical scope entry and restoration, definition facts, reference facts, and fresh instantiation. A nonrecursive-let helper checks the initializer outside the new binding and delegates generalization to an explicit policy. Pure HM generalization is not an implicit policy for mutable references or Strict's dictionary evidence.

Rules compose binding helpers with the chosen theory's operations. They keep parameter and pure-let coordination in the binding handle without turning typing rules into a second semantic language. Custom rules remain ordinary generators.

## Execution and publication

The checking kernel uses an iterative instruction machine. Computation-local mutable collections allocate during execution and publish snapshots. The precise transaction and cleanup contracts are in [Checking runtime contracts](checking-runtime.md).

An optional immutable compiler recipe creates configured handles for each elaboration. One operation evaluates the source, records observations, produces a detached partial result when possible, and runs the selected finalizer only on a clean path. It checks diagnostics again after finalization.

The public outcome distinguishes checked, recovered, and failed work. Only clean finalization constructs an opaque checked artifact. A recovered term or hole remains inspectable but is not a normal compiler-emission input. The language's finalizer owns its unresolved obligations, escaping variables, holes, and completion policy. A brand enforces pipeline use; it is not a universal type-soundness proof.

Raw staged IR remains independently constructible and emit-able after structural validation. That API does not advertise a source-language typing proof.

## Module ownership

| Module                         | Owned decisions                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `src/check.ts`                 | Execution frames, generators, transactions, scoped access, and diagnostics                |
| `src/types/hm.ts`              | HM variables, occurs checks, schemes, instantiation, and generalization                   |
| `src/types/higher-rank.ts`     | Level-based predicative quantifiers, rigid scopes, subsumption, rows, and nominal data    |
| `src/judgments.ts`             | Exhaustive rule dispatch, checking modes, source attribution, and observation             |
| Binding helpers                | Declaration/use coordination and explicit generalization policy                           |
| Elaboration runner             | Partial publication, clean-only finalization, and opaque artifacts                        |
| Compiler recipe                | Fresh configuration and one source-to-outcome operation                                   |
| `src/operations/descriptor.ts` | Exact descriptor records; `src/javascript.ts` derives exhaustive backend tables from them |

Typed descriptors remain the static source of handler shapes. Runtime symbols remain the dispatch authority. Two factory calls can produce identical TypeScript types and different operation identities. Programs snapshot their selected registry at publication.

Source and rule observations identify the actual judgments that ran. Constraint explanations use explicit causal links; they do not claim to statically inspect arbitrary generator control flow. Normal speculative rollback removes abandoned facts and constraints.

## Alternatives and synthesis

Two isolated candidates considered the entire authoring model. Candidate A used exhaustive tables, independent judgments, and coherent theories. Candidate B used a declaration-first language builder with service factories and preset forms.

The independent design reviewer scored A at 21/25 and B at 19/25. A is the base because its mapped table and mode-entry contracts are concrete, and it preserves arbitrary ASTs without a mandatory schema. B's selector and preset guarantees depend on generic contracts its sketch does not establish.

The useful grafts are small form recipes, a fresh-execution compiler recipe, and explicit recovery classification. The mandatory schema, service identity/version framework, universal solver composition, capability-effect rows, and incremental scheduler are rejected. Optional syntax declarations do not own parsing or typing semantics.

Both sketches incorrectly prohibited all `finally` yields. The implemented contract permits normal successful yields and rejects yields only during forced closure. The runtime tests establish that distinction.

The review ran in a separate read-only session. The configured reviewer reported GPT-6.1 Sol, so this was an independent review, not a different-model-family review.

## Semantic limits

The higher-rank implementation is Advanced's lexical-level predicative system. Its tests cover annotated polymorphism, monotype solutions, level lowering, rigid disagreement, and escape through rows and data. Extraction does not implement Dunfield and Krishnaswami's ordered-context algorithm or establish its soundness and completeness theorem.

Structural union/intersection subtyping, impredicative inference, guest macro hygiene, and a cross-repository runtime package are not silently added. Strict's evidence-aware type system remains a separate implementation unless a coherent extraction demonstrates the same behavior.

The final check is the consumer experience: the representative compiler must use library solvers and short rules, execute the requested examples, retain facts after errors, reject missing rules and invalid phases, and expose readable editor types. Runtime tests, TypeScript tests, editor checks, and mutation controls verify those claims on their matching paths.
