import { Check, check, fail } from "../check.ts";
import { assign, pruneLink, variableNames } from "../inference.ts";

export type Type =
  | { readonly kind: "number" | "boolean"; }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type; }
  | Variable;

export type Variable = { readonly kind: "variable"; instance?: Type; };
export type Scheme = { readonly type: Type; readonly variables: ReadonlySet<Variable>; };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });
export const fresh = (): Check<Variable> => new Check(() => ({ ok: true, value: { kind: "variable" } }));
export const prune = (type: Type): Type =>
  pruneLink(type, (value) => value.kind === "variable" ? value : null, (variable) => variable.instance);

export const show = (type: Type): string => {
  const name = variableNames<Variable>();
  const visit = (input: Type): string => {
    const type = prune(input);
    if (type.kind === "function") return `(${visit(type.param)} -> ${visit(type.result)})`;
    return type.kind === "variable" ? name(type) : type.kind;
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

const occurs = (variable: Variable, input: Type): boolean => {
  const type = prune(input);
  if (type.kind === "variable") return type === variable;
  return type.kind === "function" && (occurs(variable, type.param) || occurs(variable, type.result));
};

const unifyTypes = (left: Type, right: Type): Check<void> =>
  check(function*() {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (occurs(a, b)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      yield* assign(a, "instance", b);
    } else if (b.kind === "variable") yield* unifyTypes(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unifyTypes(a.param, b.param);
      yield* unifyTypes(a.result, b.result);
    } else if (a.kind !== b.kind) return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  });

export const unify = (left: Type, right: Type): Check<void> => unifyTypes(left, right).atomic();

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
    if (scheme.variables.size === 0) return scheme.type;
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
