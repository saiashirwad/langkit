import { check, fail, type Check } from "langkit";

// Inference belongs to this language, not the IR or the checking runner.
export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "record"; readonly row: Row }
  | { readonly kind: "data"; readonly constructor: TypeConstructor; readonly args: readonly Type[] }
  | { readonly kind: "forall"; readonly variables: readonly Generic[]; readonly body: Type }
  | { readonly kind: "skolem"; readonly name: string; readonly id: symbol; readonly level: number }
  | Generic
  | Variable;

export type Generic = { readonly kind: "generic"; readonly name: string; readonly id: symbol };
export type TypeConstructor = { readonly id: symbol; readonly name: string; readonly arity: number };
export const generic = (name: string): Generic => ({ kind: "generic", name, id: Symbol(name) });
export const data = (constructor: TypeConstructor, args: readonly Type[]): Type => {
  if (constructor.arity !== args.length) throw new Error(`Type ${constructor.name} expects ${constructor.arity} arguments`);
  return { kind: "data", constructor, args };
};
export const forall = (variables: readonly Generic[], body: Type): Type => ({ kind: "forall", variables, body });

export type Variable = { readonly kind: "variable"; level: number; instance?: Type };
export type RowVariable = { readonly kind: "row-variable"; readonly lacks: Set<string>; level: number; instance?: Row };
export type Row = { readonly fields: ReadonlyMap<string, Type>; readonly tail: RowVariable | null };
type FreeVariable = Variable | RowVariable;
export type Scheme = { readonly type: Type; readonly variables: ReadonlySet<FreeVariable> };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };
export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });
export const record = (row: Row): Type => ({ kind: "record", row });
export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  tail: RowVariable | null = null,
): Row => ({ fields, tail });
export const fresh = (level = 0): Variable => ({ kind: "variable", level });
export const freshRow = (lacks: Iterable<string> = [], level = 0): RowVariable => ({
  level,
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
    if (type.kind === "generic") return type.name;
    if (type.kind === "skolem") return `^${type.name}`;
    if (type.kind === "forall") return `(forall ${type.variables.map(v => v.name).join(" ")}. ${visit(type.body)})`;
    if (type.kind === "data") return type.constructor.name + (type.args.length ? `(${type.args.map(visit).join(", ")})` : "");
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

const freeRow = (input: Row, found: Set<FreeVariable>): void => {
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
  else if (type.kind === "data") for (const arg of type.args) free(arg, found);
  else if (type.kind === "forall") free(type.body, found);
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
const solveRow = (variable: RowVariable, input: Row): Check<void> =>
  check(function* () {
    const target = flatten(input);
    if (!target.fields.size && target.tail === variable) return;
    const variables = new Set<FreeVariable>();
    freeRow(target, variables);
    if (variables.has(variable)) return yield* fail("Infinite row");
    yield* lower(record(target), variable.level);
    yield* exclude(target, variable.lacks);
    // Preserve the unique-label invariant even when the target is assembled by unification.
    if (target.tail) for (const label of target.fields.keys()) target.tail.lacks.add(label);
    variable.instance = target;
  });
const unifyRows = (left: Row, right: Row): Check<void> =>
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
      const shared = freshRow([], Math.min(a.tail.level, b.tail.level));
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
      if (b.kind === "forall") return yield* fail("Cannot infer an impredicative type; add an explicit polymorphic annotation");
      yield* lower(b, a.level);
      a.instance = b;
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind === "record" && b.kind === "record") yield* unifyRows(a.row, b.row);
    else if (a.kind === "data" && b.kind === "data" && a.constructor.id === b.constructor.id) {
      for (let i = 0; i < a.args.length; i++) yield* unify(a.args[i]!, b.args[i]!);
    } else if (a.kind === "forall" && b.kind === "forall" && a.variables.length === b.variables.length) {
      // Alpha-equivalence uses fresh rigid witnesses outside every existing meta's scope.
      const level = Math.max(maxLevel(a), maxLevel(b)) + 1;
      const witnesses = a.variables.map(v => skolem(v.name, level));
      yield* unify(substitute(a.body, new Map(a.variables.map((v, i) => [v, witnesses[i]!]))),
        substitute(b.body, new Map(b.variables.map((v, i) => [v, witnesses[i]!]))));
    } else if (a.kind === "generic" && b.kind === "generic" && a.id === b.id) return;
    else if (a.kind === "skolem" && b.kind === "skolem" && a.id === b.id) return;
    else if (a.kind !== b.kind || !["number", "boolean", "string"].includes(a.kind))
      return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  });

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });
export const generalize = (type: Type, environment: Iterable<Scheme>): Scheme => {
  const variables = free(type);
  for (const scheme of environment) {
    for (const variable of free(scheme.type)) {
      if (!scheme.variables.has(variable)) variables.delete(variable);
    }
  }
  return { type, variables };
};
export const instantiate = (scheme: Scheme, level = 0): Type => {
  const replacements = new Map<Variable, Variable>();
  const rows = new Map<RowVariable, RowVariable>();
  const visitRow = (input: Row): Row => {
    const flat = flatten(input);
    let tail = flat.tail;
    if (tail && scheme.variables.has(tail)) {
      if (!rows.has(tail)) rows.set(tail, freshRow(tail.lacks, level));
      tail = rows.get(tail)!;
    }
    return row(new Map([...flat.fields].map(([name, type]) => [name, visit(type)])), tail);
  };
  const visit = (type: Type): Type => {
    type = prune(type);
    if (type.kind === "function") return fn(visit(type.param), visit(type.result));
    if (type.kind === "record") return record(visitRow(type.row));
    if (type.kind === "data") return data(type.constructor, type.args.map(visit));
    if (type.kind === "forall") return forall(type.variables, visit(type.body));
    if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
    if (!replacements.has(type)) replacements.set(type, fresh(level));
    return replacements.get(type)!;
  };
  return visit(scheme.type);
};


// Levels are lexical skolem scopes, not let-generalization levels. Connecting an
// outer meta to an inner structure lowers every reachable unsolved meta, including
// row tails, so a later assignment cannot smuggle a rigid type out of its scope.
const lower = (type: Type, level: number, bound: ReadonlySet<Generic> = new Set()): Check<void> =>
  check(function* () {
    type = prune(type);
    switch (type.kind) {
      case "variable": type.level = Math.min(type.level, level); return;
      case "skolem":
        if (type.level > level) return yield* fail(`Skolem escape: ${show(type)}`);
        return;
      case "generic":
        if (!bound.has(type)) return yield* fail(`Escaping generic type: ${type.name}`);
        return;
      case "function":
        yield* lower(type.param, level, bound);
        yield* lower(type.result, level, bound);
        return;
      case "data":
        for (const arg of type.args) yield* lower(arg, level, bound);
        return;
      case "forall":
        yield* lower(type.body, level, new Set([...bound, ...type.variables]));
        return;
      case "record": {
        const { fields, tail } = flatten(type.row);
        for (const field of fields.values()) yield* lower(field, level, bound);
        if (tail) tail.level = Math.min(tail.level, level);
        return;
      }
    }
  });

const maxLevel = (type: Type): number => {
  type = prune(type);
  switch (type.kind) {
    case "variable": case "skolem": return type.level;
    case "function": return Math.max(maxLevel(type.param), maxLevel(type.result));
    case "forall": return maxLevel(type.body);
    case "data": return Math.max(0, ...type.args.map(maxLevel));
    case "record": {
      const { fields, tail } = flatten(type.row);
      return Math.max(tail?.level ?? 0, ...[...fields.values()].map(maxLevel));
    }
    default: return 0;
  }
};

/** Capture-avoiding substitution of explicitly bound ordinary type parameters. */
export const substitute = (type: Type, replacements: ReadonlyMap<Generic, Type>): Type => {
  type = prune(type);
  switch (type.kind) {
    case "generic": return replacements.get(type) ?? type;
    case "function": return fn(substitute(type.param, replacements), substitute(type.result, replacements));
    case "data": return data(type.constructor, type.args.map(arg => substitute(arg, replacements)));
    case "record": {
      const { fields, tail } = flatten(type.row);
      return record(row(new Map([...fields].map(([name, field]) => [name, substitute(field, replacements)])), tail));
    }
    case "forall": {
      const local = new Map(replacements);
      for (const variable of type.variables) local.delete(variable);
      return forall(type.variables, substitute(type.body, local));
    }
    default: return type;
  }
};

export const instantiateForall = (type: Type, level = 0): Type => {
  type = prune(type);
  while (type.kind === "forall") {
    type = prune(substitute(type.body, new Map(type.variables.map(variable => [variable, fresh(level)]))));
  }
  return type;
};

const skolem = (name: string, level: number): Type => ({ kind: "skolem", name, level, id: Symbol(name) });
export const skolemize = (type: Type, level: number): Type => {
  type = prune(type);
  while (type.kind === "forall") {
    type = prune(substitute(type.body, new Map(type.variables.map(variable => [variable, skolem(variable.name, level)]))));
  }
  return type;
};

/** Predicative subsumption; expected polymorphism is checked using rigid witnesses. */
export const subsume = (actual: Type, expected: Type, level = 0): Check<void> =>
  check(function* () {
    const target = prune(expected);
    if (target.kind === "forall") {
      yield* subsume(instantiateForall(actual, level + 1), skolemize(target, level + 1), level + 1);
      return;
    }
    const source = instantiateForall(actual, level);
    if (source.kind === "function" && target.kind === "function") {
      yield* subsume(target.param, source.param, level);
      yield* subsume(source.result, target.result, level);
    } else yield* unify(source, target);
  });
