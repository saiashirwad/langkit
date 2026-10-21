# Inference theory contracts

`langkit/types/higher-rank` owns the runtime type grammar. ASTs, bindings, IR, source locations, and recursion policy stay outside the solver modules.

## Hindley–Milner core

The rank-1 core of `langkit/types/higher-rank` is Hindley–Milner: numeric and Boolean types, function types, and inference variables. Polymorphism belongs to `Scheme`, which pairs a type with a set of quantified variables.

- `fresh()` allocates a variable during execution.
- `unify(left, right)` checks equality, rejects occurs-check failures, and journals links.
- `generalize(type, environment)` quantifies variables not free in the supplied environment schemes.
- `instantiate(scheme)` freshens quantified variables for one use.
- `mono(type)` creates an unquantified scheme.
- `prune`, `free`, and `show` inspect types without changing links.

```ts
import { check, run } from "langkit";
import * as rank from "langkit/types/higher-rank";

const result = run(check(function*() {
  const a = yield* rank.fresh();
  const identity = yield* rank.generalize(rank.fn(a, a), []);
  const numeric = yield* rank.instantiate(identity);
  const logical = yield* rank.instantiate(identity);
  yield* rank.unify(numeric, rank.fn(rank.number, rank.number));
  yield* rank.unify(logical, rank.fn(rank.boolean, rank.boolean));
  return [rank.show(numeric), rank.show(logical)];
}));
```

The success value is `["(number -> number)", "(boolean -> boolean)"]`.

Pure, nonrecursive let bindings can generalize against outer schemes. Parameters remain monomorphic. A recursive initializer needs a language-owned recursion policy.

## Level-based predicative higher rank

The same module adds explicit `forall`, identity-based generic variables, rigid skolems, lexical levels, and nominal parameterized data constructors. It is extracted from the Advanced language's level-based algorithm. It is not Dunfield and Krishnaswami's ordered-context calculus, and no soundness or completeness theorem is claimed.

`instantiateForall` opens outer quantifiers with fresh inference variables. `skolemize` opens them with fresh rigid witnesses. `subsume(actual, expected, level)` checks expected polymorphism under rigid witnesses and applies contravariant parameter checking for functions. `expectFunction` opens an actual quantified type or constrains a monotype to an arrow.

Linking a variable lowers reachable unsolved ordinary and row variables before assignment. An outer variable cannot acquire an inner rigid witness through a function, record, or nominal data argument.

Advanced checks annotated higher-rank parameters and results bidirectionally. It does not infer polymorphic lambda parameters or solve an inference variable directly to a `forall`. Its source-level restrictions on polymorphic record fields and data arguments remain language policies. Pure lets generalize. Unannotated recursive initializers are monomorphic while being checked; explicit polymorphic recursive annotations permit annotated polymorphic recursion.

There is no structural subtyping or impredicative inference.

## State and rollback

Solver computations allocate fresh cells and replacement maps during execution. Reusing an instantiation computation twice in one run produces distinct fresh cells, while repeated quantified occurrences within one use share their replacement.

Links, absence constraints, and levels use the mutation journal. Failed compound unification restores them without an outer transaction. Pruning never performs unjournaled path compression.

Type objects are mutable solver data, not detached editor snapshots. Retaining and reusing a variable across runs retains that object. Allocate variables within the checking task and supply a snapshot policy at publication boundaries.

## Verification

`tests/theories.test.ts` covers computation reuse, solved-environment generalization, absence propagation, rollback, and rigid escape. `tests/languages.test.ts` checks source behavior and emitted execution.

```sh
node --test tests/theories.test.ts tests/languages.test.ts
```
