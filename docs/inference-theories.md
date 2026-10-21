# Inference theory contracts

The three supported theories own separate runtime type grammars. Their types are not interchangeable, even where the constructor names match. ASTs, bindings, IR, source locations, and recursion policy stay outside the solver modules.

## Hindley–Milner

`langkit/types/hm` has numeric and Boolean types, function types, and inference variables. Polymorphism belongs to `Scheme`, which pairs a type with a set of quantified variables.

- `fresh()` allocates a variable during execution.
- `unify(left, right)` checks equality, rejects occurs-check failures, and journals links.
- `generalize(type, environment)` quantifies variables not free in the supplied environment schemes.
- `instantiate(scheme)` freshens quantified variables for one use.
- `mono(type)` creates an unquantified scheme.
- `prune`, `free`, and `show` inspect types without changing links.

```ts
import { check, run } from "langkit";
import * as hm from "langkit/types/hm";

const result = run(check(function*() {
  const a = yield* hm.fresh();
  const identity = yield* hm.generalize(hm.fn(a, a), []);
  const numeric = yield* hm.instantiate(identity);
  const logical = yield* hm.instantiate(identity);
  yield* hm.unify(numeric, hm.fn(hm.number, hm.number));
  yield* hm.unify(logical, hm.fn(hm.boolean, hm.boolean));
  return [hm.show(numeric), hm.show(logical)];
}));
```

The success value is `["(number -> number)", "(boolean -> boolean)"]`.

Pure, nonrecursive let bindings can generalize against outer schemes. Parameters remain monomorphic. A recursive initializer needs a language-owned recursion policy.

## Level-based predicative higher rank

`langkit/types/higher-rank` adds explicit `forall`, identity-based generic variables, rigid skolems, lexical levels, and nominal parameterized data constructors. It is extracted from the Advanced language's level-based algorithm. It is not Dunfield and Krishnaswami's ordered-context calculus, and no soundness or completeness theorem is claimed.

`instantiateForall` opens outer quantifiers with fresh inference variables. `skolemize` opens them with fresh rigid witnesses. `subsume(actual, expected, level)` checks expected polymorphism under rigid witnesses and applies contravariant parameter checking for functions. `expectFunction` opens an actual quantified type or constrains a monotype to an arrow.

`withRigidScope(expected, level, body)` supplies the opened type and the inner level. It does not manage the language's lexical environment or inspect arbitrary returned terms. The language must use the supplied level for inner allocations and prevent forbidden witnesses from entering published results.

Linking a variable lowers reachable unsolved ordinary and row variables before assignment. An outer variable cannot acquire an inner rigid witness through a function, record, or nominal data argument.

Advanced checks annotated higher-rank parameters and results bidirectionally. It does not infer polymorphic lambda parameters or solve an inference variable directly to a `forall`. Its source-level restrictions on polymorphic record fields and data arguments remain language policies. Pure lets generalize. Unannotated recursive initializers are monomorphic while being checked; explicit polymorphic recursive annotations permit annotated polymorphic recursion.

There is no structural subtyping or impredicative inference.

## State and rollback

Solver computations allocate fresh cells and replacement maps during execution. Reusing an instantiation computation twice in one run produces distinct fresh cells, while repeated quantified occurrences within one use share their replacement.

Links, absence constraints, and levels use the mutation journal. Failed compound unification restores them without requiring an outer speculative attempt. Pruning never performs unjournaled path compression.

Type objects are mutable solver data, not detached editor snapshots. Retaining and reusing a variable across runs retains that object. Allocate variables within the checking task and supply a snapshot policy at publication boundaries.

## Verification

`tests/theories.test.ts` covers computation reuse, solved-environment generalization, absence propagation, rollback, and rigid escape. `tests/languages.test.ts` checks source behavior and emitted execution.

```sh
node --test tests/theories.test.ts tests/languages.test.ts
```
