import { check, diagnostics, runDetailed, type Check } from "./check.ts";
import type { Diagnostic } from "./diagnostic.ts";

const publication = Symbol();
class CheckedValue<A> {
  readonly #checked = true;
  readonly value: A;
  constructor(value: A, token: typeof publication) {
    if (token !== publication) throw new TypeError("Checked artifacts require clean finalization");
    this.value = value;
    Object.freeze(this);
  }
  static contains(value: unknown): value is CheckedValue<unknown> {
    return typeof value === "object" && value !== null && #checked in value;
  }
}
export type CheckedArtifact<A> = CheckedValue<A>;
export type CheckedModule<A> = CheckedArtifact<A>;
export const isChecked = (value: unknown): value is CheckedArtifact<unknown> => CheckedValue.contains(value);
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
      const finalized = yield* policy.finalize(value).withDiagnostics((error) => ({ ...error, code: error.code ?? "elaboration.finalization" }));
      if ((yield* diagnostics()).length === 0) artifact = new CheckedValue(finalized, publication);
    }
  });
  const result = runDetailed(check(function* () {
    yield* computation.recover();
    facts = yield* policy.facts;
  }));
  if (result.status === "failed") throw new TypeError("Observation publication must complete", { cause: result.diagnostics });
  if (artifact && result.status === "completed" && result.diagnostics.length === 0)
    return { status: "checked", artifact, partial: partial as P, facts, diagnostics: [] };
  return hasPartial
    ? { status: "recovered", partial: partial as P, facts, diagnostics: result.diagnostics }
    : { status: "failed", facts, diagnostics: result.diagnostics };
};
