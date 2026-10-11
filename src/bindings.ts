import { bind, check, get, lookup, scoped, type Check } from "./check.ts";
import type { DefinitionKind } from "./analysis.ts";
import type { Span } from "./diagnostic.ts";
import type { Synthesized } from "./judgments.ts";

export interface BindingEntry<Handle, Scheme> { readonly binding: Handle; readonly scheme: Scheme }
export interface BindingPolicy<Type, Term, Handle extends { readonly id: symbol; readonly name: string }, Scheme> {
  readonly monomorphic: (type: Type) => Scheme;
  readonly instantiate: (scheme: Scheme) => Check<Type>;
  readonly generalize: (type: Type, outer: readonly Scheme[]) => Check<Scheme>;
  readonly parameter: (name: string, type: Type) => Handle;
  readonly declare: (name: string, value: Synthesized<Type, Term>) => Check<Handle>;
  readonly reference: (handle: Handle, type: Type) => Term;
  readonly define?: (handle: Handle, type: Type, span: Span, kind: DefinitionKind) => Check<void>;
  readonly use?: (handle: Handle, type: Type, span: Span) => Check<void>;
}
export const createBindings = <T, E, H extends { readonly id: symbol; readonly name: string }, S>(policy: BindingPolicy<T, E, H, S>) => {
  const environment = scoped<ReadonlyMap<string, BindingEntry<H, S>>>(new Map());
  const scope = <A>(entries: Iterable<readonly [string, BindingEntry<H, S>]>, body: Check<A>): Check<A> => bind(environment, entries, body);
  return {
    environment,
    scope,
    reference: (name: string, span: Span): Check<Synthesized<T, E>> => check(function* () {
      const entry = yield* lookup(environment, name);
      const type = yield* policy.instantiate(entry.scheme);
      if (policy.use) yield* policy.use(entry.binding, type, span);
      return { type, term: policy.reference(entry.binding, type) };
    }),
    parameter: <A>(name: string, type: T, span: Span, body: (handle: H) => Check<A>): Check<A> => check(function* () {
      const handle = policy.parameter(name, type);
      if (policy.define) yield* policy.define(handle, type, span, "parameter");
      return yield* scope([[name, { binding: handle, scheme: policy.monomorphic(type) }]], body(handle));
    }),
    let: <A>(name: string, span: Span, initializer: Check<Synthesized<T, E>>, body: (handle: H, value: Synthesized<T, E>) => Check<A>): Check<A> => check(function* () {
      const value = yield* initializer;
      const outer = yield* get(environment);
      const scheme = yield* policy.generalize(value.type, [...outer.values()].map((entry) => entry.scheme));
      const handle = yield* policy.declare(name, value);
      if (policy.define) yield* policy.define(handle, value.type, span, "variable");
      return yield* scope([[name, { binding: handle, scheme }]], body(handle, value));
    }),
  };
};
