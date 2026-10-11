import { type Check, check, fail } from "../check.ts";
import { assign, pruneLink } from "../inference.ts";

export type Type =
  | { readonly kind: "number" | "boolean"; }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type; }
  | Variable;

export type Variable = { readonly kind: "variable"; instance?: Type; };
export type Scheme = { readonly type: Type; readonly variables: ReadonlySet<Variable>; };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });
export const fresh = (): Check<Variable> =>
  check(function*() {
    return { kind: "variable" };
  });
export const prune = (type: Type): Type =>
  pruneLink(type, (value) => value.kind === "variable" ? value : null, (variable) => variable.instance);

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const visit = (input: Type): string => {
    const type = prune(input);
    if (type.kind === "function") return `(${visit(type.param)} -> ${visit(type.result)})`;
    if (type.kind !== "variable") return type.kind;
    if (!names.has(type)) {
      const index = names.size;
      names.set(type, String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""));
    }
    return names.get(type)!;
  };
  return visit(type);
};

export const free = (input: Type, found = new Set<Variable>()): Set<Variable> => {
  const type = prune(input);
  if (type.kind === "variable") found.add(type);
  else if (type.kind === "function") {
    free(type.param, found);
    free(type.result, found);
  }
  return found;
};

export const unify = (left: Type, right: Type): Check<void> =>
  check(function*() {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      yield* assign(a, "instance", b);
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind !== b.kind) return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  }).atomic();

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });

export const generalize = (type: Type, environment: Iterable<Scheme>): Check<Scheme> =>
  check(function*() {
    const variables = free(type);
    for (const scheme of environment) {
      for (const variable of free(scheme.type)) {
        if (!scheme.variables.has(variable)) variables.delete(variable);
      }
    }
    return { type, variables };
  });

export const instantiate = (scheme: Scheme): Check<Type> =>
  check(function*() {
    const replacements = new Map<Variable, Variable>();
    const visit = (input: Type): Type => {
      const type = prune(input);
      if (type.kind === "function") return fn(visit(type.param), visit(type.result));
      if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
      if (!replacements.has(type)) replacements.set(type, { kind: "variable" });
      return replacements.get(type)!;
    };
    return visit(scheme.type);
  });
