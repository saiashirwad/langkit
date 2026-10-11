import { check, diagnostics, runDetailed, type Check } from "./check.ts";
import type { Diagnostic } from "./diagnostic.ts";

const checked = Symbol("checked artifact");
export interface CheckedArtifact<A> { readonly value: A; readonly [checked]: true }
export type CheckedModule<A> = CheckedArtifact<A>;
export type Outcome<A, P, F> =
  | { readonly status: "checked"; readonly artifact: CheckedArtifact<A>; readonly partial: P; readonly facts: F; readonly diagnostics: readonly [] }
  | { readonly status: "recovered"; readonly partial: P; readonly facts: F; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "failed"; readonly facts: F; readonly diagnostics: readonly Diagnostic[] };
export interface ElaborationPolicy<V, A, P, F> {
  readonly elaborate: Check<V>;
  readonly finalize: (value: V) => Check<A>;
  readonly snapshot: (value: V) => P;
  readonly facts: Check<F>;
}
export const elaborate = <V, A, P, F>(policy: ElaborationPolicy<V, A, P, F>): Outcome<A, P, F> => {
  let partial: P | undefined;
  let hasPartial = false;
  let artifact: CheckedArtifact<A> | undefined;
  let facts!: F;
  const computation = check(function* () {
    const value = yield* policy.elaborate;
    partial = policy.snapshot(value);
    hasPartial = true;
    if ((yield* diagnostics()).length === 0) {
      const finalized = yield* policy.finalize(value);
      if ((yield* diagnostics()).length === 0) artifact = { value: finalized, [checked]: true };
    }
  });
  const result = runDetailed(check(function* () {
    yield* computation.recover();
    facts = yield* policy.facts;
  }));
  if (artifact && result.status === "completed" && result.diagnostics.length === 0)
    return { status: "checked", artifact, partial: partial as P, facts, diagnostics: [] };
  return hasPartial
    ? { status: "recovered", partial: partial as P, facts, diagnostics: result.diagnostics }
    : { status: "failed", facts, diagnostics: result.diagnostics };
};
