# Checking runtime contracts

`Check<A>` describes synchronous checking work. `check(factory)` constructs a fresh generator for each execution. `yield* computation` returns that computation's successful value. Expected failures are diagnostics. JavaScript exceptions propagate as programming errors.

## Execution and state lifetimes

`run(computation)` creates fresh managed state and diagnostic storage. A `State<T>` initializes lazily, once per run, when the runtime first reads its key. Reusing the same state key within a run intentionally reuses its value.

A computation-local collection needs a new state key during each execution. The checked IR adapter follows this rule. Reusing one `code.body(factory)` twice in a run creates distinct declaration arrays and fresh declaration bindings. Each published body contains a snapshot, not the mutable collection buffer.

`Scoped<T>` holds an immutable scoped value. `within(key, update, body)` derives the body's environment and restores the outer environment on completion, failure, or exception. `bind` extends a scoped map. It does not modify the outer map.

The built-in evaluator uses an explicit continuation stack. Deep `map`, `flatMap`, yielded `Check` generators, scoped environments, transactions, and ordered choices do not consume proportional JavaScript call stack. The regression suite executes 20,000 layers of ordinary composition and 2,000 layers of transactions and choice.

This guarantee does not cover arbitrary JavaScript recursion, native generator delegation that never yields a `Check`, or recursively reentrant custom primitive callbacks.

## Transactions and diagnostics

| Operation                 | Successful result                                                               | Expected failure or exception                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `recover(fallback)`       | Returns the original successful value                                           | Records an expected diagnostic and executes the fallback. Keeps managed mutations. Does not catch exceptions. |
| `atomic()`                | Commits managed mutations, including successful work with recovered diagnostics | Restores managed state. Does not discard recovered diagnostics. Exceptions propagate.                         |
| `attempt(computation)`    | Commits only a diagnostically clean success                                     | Restores managed state and discards diagnostics produced inside the attempt. Exceptions propagate.            |
| `choice(...alternatives)` | Commits the first clean successful attempt                                      | Returns the first alternative's failure if every alternative fails. Exceptions abort the choice.              |

An attempt that recovers a diagnostic and later fails reports its earliest recovered diagnostic. Ordered choice is not an overload-resolution or ambiguity-search algorithm.

`run` returns success only when the computation succeeds and no recovered diagnostics remain. A recovered computation can continue collecting facts without becoming eligible for ordinary code generation.

`runDetailed` retains the completed value alongside recovered diagnostics. `diagnostics()` reads the current diagnostic snapshot inside a run. `withDiagnostics` attributes failures throughout a scope, including recovered failures; `mapError` transforms a terminal failure. Scoped transformations are applied once when a custom synchronous primitive returns a failure from an already evaluated child. Mapping provenance remains local to the run.

## Managed mutation

`state(init, checkpoint)` defines managed state. Its checkpoint callback returns a restore function. Transactions restore states that already existed and remove states first initialized inside failed work.

`assign`, `add`, `put`, and `append` journal object, set, map, and array mutations. An inner commit remains reversible by a failing outer transaction. Arbitrary JavaScript mutations outside these APIs are not managed.

`pruneLink` follows solver links without modifying them. Link compression requires journaled writes if a type-system implementation adds it.

## Generator cleanup

An expected failure stops the generator. It does not throw the diagnostic into the generator's `catch` clauses. The interpreter closes suspended generators with `return`, running cleanup from the innermost generator outward.

Forced cleanup cannot yield another check. The interpreter raises `TypeError` and does not execute the yielded work. A cleanup exception replaces a pending diagnostic or exception; enclosing cleanup and transaction restoration still run.

A `finally` block reached during normal successful execution can yield checks. The restriction applies to forced closure, not every `finally` block.

## Verification

The contracts above are executable in `tests/check.test.ts`, `tests/runtime-depth.test.ts`, `tests/generator-ir.test.ts`, and `tests/diagnostic-mapping.test.ts`.

```sh
node --test tests/check.test.ts tests/diagnostic-mapping.test.ts tests/generator-ir.test.ts tests/runtime-depth.test.ts
```
