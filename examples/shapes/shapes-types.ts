// Row inference adapted from the rows example; independent language policy.
import { check, fail, type Check } from "langkit";
import type { Binding } from "langkit/ir";

export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "record"; readonly row: Row }
  | Variable;

type Variable = { readonly kind: "variable"; instance?: Type };

export type RowVariable = { readonly kind: "row-variable"; readonly lacks: Set<string>; instance?: Row };

type Row = { readonly fields: ReadonlyMap<string, Type>; readonly tail: RowVariable | null };

type FreeVariable = Variable | RowVariable;

type Scheme = { readonly type: Type; readonly variables: ReadonlySet<FreeVariable> };

export type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };

export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

export const record = (row: Row): Type => ({ kind: "record", row });

export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  tail: RowVariable | null = null,
): Row => ({ fields, tail });

export const fresh = (): Variable => ({ kind: "variable" });

export const freshRow = (lacks: Iterable<string> = []): RowVariable => ({
  kind: "row-variable",
  lacks: new Set(lacks),
});

export const prune = (type: Type): Type => {
  if (type.kind !== "variable" || !type.instance) return type;
  return (type.instance = prune(type.instance));
};

export const flatten = (input: Row): Row => {
  const fields = new Map(input.fields);
  let tail = input.tail;
  while (tail?.instance) {
    for (const [name, type] of tail.instance.fields) fields.set(name, type);
    tail = tail.instance.tail;
  }
  return row(fields, tail);
};

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const rows = new Map<RowVariable, string>();
  const visit = (type: Type): string => {
    type = prune(type);
    if (type.kind === "function") return `(${visit(type.param)} -> ${visit(type.result)})`;
    if (type.kind === "record") {
      const { fields, tail } = flatten(type.row);
      const labels = [...fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, type]) => `${name}: ${visit(type)}`);
      if (tail) {
        if (!rows.has(tail)) rows.set(tail, `r${rows.size || ""}`);
        return `{ ${labels.join(", ")}${labels.length ? " " : ""}| ${rows.get(tail)} }`;
      }
      return labels.length ? `{ ${labels.join(", ")} }` : "{}";
    }
    if (type.kind !== "variable") return type.kind;
    if (!names.has(type)) {
      const index = names.size;
      names.set(
        type,
        String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""),
      );
    }
    return names.get(type)!;
  };
  const result = visit(type);
  const constraints = [...rows]
    .filter(([variable]) => variable.lacks.size)
    .map(([variable, name]) => `${name} lacks ${[...variable.lacks].sort().join(", ")}`);
  return result + (constraints.length ? ` where ${constraints.join("; ")}` : "");
};

export const freeRow = (input: Row, found: Set<FreeVariable>): void => {
  const { fields, tail } = flatten(input);
  for (const type of fields.values()) free(type, found);
  if (tail) found.add(tail);
};

export const free = (type: Type, found = new Set<FreeVariable>()): Set<FreeVariable> => {
  type = prune(type);
  if (type.kind === "variable") found.add(type);
  else if (type.kind === "function") {
    free(type.param, found);
    free(type.result, found);
  } else if (type.kind === "record") freeRow(type.row, found);
  return found;
};

// Every row tail excludes its explicit fields. Extension adds absence constraints;
// solving a row variable checks and propagates them, including through aliases.
export const exclude = (input: Row, labels: Iterable<string>): Check<void> =>
  check(function* () {
    const { fields, tail } = flatten(input);
    for (const label of labels) {
      if (fields.has(label)) return yield* fail(`Duplicate field: ${label}`);
      tail?.lacks.add(label);
    }
  });

export const solveRow = (variable: RowVariable, input: Row): Check<void> =>
  check(function* () {
    const target = flatten(input);
    if (!target.fields.size && target.tail === variable) return;
    const variables = new Set<FreeVariable>();
    freeRow(target, variables);
    if (variables.has(variable)) return yield* fail("Infinite row");
    yield* exclude(target, variable.lacks);
    // Preserve the unique-label invariant even when the target is assembled by unification.
    if (target.tail) for (const label of target.fields.keys()) target.tail.lacks.add(label);
    variable.instance = target;
  });

export const unifyRows = (left: Row, right: Row): Check<void> =>
  check(function* () {
    let a = flatten(left);
    let b = flatten(right);
    const unified = new Set<string>();
    while (true) {
      const common = [...a.fields].filter(([label]) => b.fields.has(label) && !unified.has(label));
      if (!common.length) break;
      for (const [label, type] of common) {
        yield* unify(type, b.fields.get(label)!);
        unified.add(label);
      }
      // A field's type may share variables with either tail. Solving it can
      // expose more common fields, whose types must agree before solving tails.
      a = flatten(left);
      b = flatten(right);
    }
    const onlyA = new Map([...a.fields].filter(([label]) => !b.fields.has(label)));
    const onlyB = new Map([...b.fields].filter(([label]) => !a.fields.has(label)));
    if ((!a.tail && onlyB.size) || (!b.tail && onlyA.size))
      return yield* fail(`Missing field: ${[...(!a.tail ? onlyB : onlyA).keys()].join(", ")}`);
    if (a.tail === b.tail) {
      if (onlyA.size || onlyB.size)
        return yield* fail("Infinite row: incompatible fields share a tail");
      return;
    }
    if (a.tail && b.tail) {
      const shared = freshRow();
      yield* solveRow(a.tail, row(onlyB, shared));
      yield* solveRow(b.tail, row(onlyA, shared));
    } else if (a.tail) yield* solveRow(a.tail, row(onlyB));
    else if (b.tail) yield* solveRow(b.tail, row(onlyA));
  });

export const unify = (left: Type, right: Type): Check<void> =>
  check(function* () {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      a.instance = b;
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind === "record" && b.kind === "record") yield* unifyRows(a.row, b.row);
    else if (a.kind !== b.kind) return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  });

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });

export const generalize = (type: Type, environment: ReadonlyMap<string, Entry>): Scheme => {
  const variables = free(type);
  for (const { scheme } of environment.values()) {
    for (const variable of free(scheme.type)) {
      if (!scheme.variables.has(variable)) variables.delete(variable);
    }
  }
  return { type, variables };
};

export const instantiate = (scheme: Scheme): Type => {
  const replacements = new Map<Variable, Variable>();
  const rows = new Map<RowVariable, RowVariable>();
  const visitRow = (input: Row): Row => {
    const flat = flatten(input);
    let tail = flat.tail;
    if (tail && scheme.variables.has(tail)) {
      if (!rows.has(tail)) rows.set(tail, freshRow(tail.lacks));
      tail = rows.get(tail)!;
    }
    return row(new Map([...flat.fields].map(([name, type]) => [name, visit(type)])), tail);
  };
  const visit = (type: Type): Type => {
    type = prune(type);
    if (type.kind === "function") return fn(visit(type.param), visit(type.result));
    if (type.kind === "record") return record(visitRow(type.row));
    if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
    if (!replacements.has(type)) replacements.set(type, fresh());
    return replacements.get(type)!;
  };
  return visit(scheme.type);
};

