import { elaborate, type CheckedArtifact, type ElaborationPolicy, type Outcome } from "./elaboration.ts";

export interface CompilerRecipe<Source, V, A, P, F, Output> {
  readonly configure: (source: Source) => ElaborationPolicy<V, A, P, F>;
  readonly emit: (artifact: A) => Output;
}
export interface Compiler<Source, A, P, F, Output> {
  elaborate(source: Source): Outcome<A, P, F>;
  emit(artifact: CheckedArtifact<A>): Output;
}
export const createCompiler = <Source, V, A, P, F, Output>(recipe: CompilerRecipe<Source, V, A, P, F, Output>): Compiler<Source, A, P, F, Output> => Object.freeze({
  elaborate: (source: Source) => elaborate(recipe.configure(source)),
  emit: (artifact: CheckedArtifact<A>) => recipe.emit(artifact.value),
});
