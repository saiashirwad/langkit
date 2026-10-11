import { pruneLink } from "langkit/inference"
import { check, fail, run, type Check } from "langkit";

export type Kind =
  | { readonly kind: "type" }
  | { readonly kind: "arrow"; readonly param: Kind; readonly result: Kind }
  | { readonly kind: "kind-variable"; instance?: Kind };

export const typeKind: Kind = { kind: "type" };

export const kindArrow = (param: Kind, result: Kind): Kind => ({ kind: "arrow", param, result });

export const freshKind = (): Kind => ({ kind: "kind-variable" });
type KindVariable = Extract<Kind, { readonly kind: "kind-variable" }>;
const kindVariable = (value: Kind): KindVariable | null =>
  value.kind === "kind-variable" ? value : null;
const kindInstance = (variable: KindVariable): Kind | undefined => variable.instance;
const linkKind = (variable: KindVariable, instance: Kind): void => {
  variable.instance = instance;
};

export const pruneKind = (kind: Kind): Kind =>
  pruneLink(kind, kindVariable, kindInstance, linkKind);

export const showKind = (kind: Kind): string => {
  const names = new Map<Kind, string>();
  const visit = (kind: Kind): string => {
    kind = pruneKind(kind);
    if (kind.kind === "type") return "Type";
    if (kind.kind === "arrow") return `(${visit(kind.param)} -> ${visit(kind.result)})`;
    if (!names.has(kind)) names.set(kind, `k${names.size}`);
    return names.get(kind)!;
  };
  return visit(kind);
};

/** Finalize a declaration's inferred kinds; call only after the whole group is checked. */
export const defaultKind = (input: Kind): void => {
  const kind = pruneKind(input);
  if (kind.kind === "kind-variable") kind.instance = typeKind;
  else if (kind.kind === "arrow") {
    defaultKind(kind.param);
    defaultKind(kind.result);
  }
};

const kindOccurs = (variable: Kind, input: Kind): boolean => {
  const kind = pruneKind(input);
  return (
    variable === kind ||
    (kind.kind === "arrow" &&
      (kindOccurs(variable, kind.param) || kindOccurs(variable, kind.result)))
  );
};

export const unifyKinds = (left: Kind, right: Kind): Check<void> =>
  check(function* () {
    const a = pruneKind(left);
    const b = pruneKind(right);
    if (a === b) return;
    if (a.kind === "kind-variable") {
      if (kindOccurs(a, b)) return yield* fail("Infinite kind");
      a.instance = b;
    } else if (b.kind === "kind-variable") yield* unifyKinds(b, a);
    else if (a.kind === "arrow" && b.kind === "arrow") {
      yield* unifyKinds(a.param, b.param);
      yield* unifyKinds(a.result, b.result);
    } else if (a.kind !== b.kind)
      return yield* fail(`Kind mismatch: ${showKind(a)} versus ${showKind(b)}`);
  });

// Kinds and constraints belong to this example, not the shared IR/checking runner.
export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type }
  | { readonly kind: "record"; readonly row: Row }
  | { readonly kind: "constructor"; readonly constructor: TypeConstructor }
  | { readonly kind: "application"; readonly fn: Type; readonly arg: Type; readonly typeKind: Kind }
  | { readonly kind: "forall"; readonly variables: readonly Generic[]; readonly body: Type }
  | { readonly kind: "qualified"; readonly predicates: readonly Predicate[]; readonly type: Type }
  | {
      readonly kind: "skolem";
      readonly name: string;
      readonly id: symbol;
      readonly level: number;
      readonly typeKind: Kind;
    }
  | Generic
  | Variable;

export type Predicate = { readonly className: string; readonly arg: Type };

export type Generic = {
  readonly kind: "generic";
  readonly name: string;
  readonly id: symbol;
  readonly typeKind: Kind;
};

export type TypeConstructor = {
  readonly id: symbol;
  readonly name: string;
  readonly arity: number;
  readonly parameters?: readonly Kind[];
};

export type Variable = {
  readonly kind: "variable";
  readonly typeKind: Kind;
  level: number;
  instance?: Type;
};

export type RowVariable = {
  readonly kind: "row-variable";
  readonly lacks: Set<string>;
  level: number;
  instance?: Row;
};

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

export const fresh = (level = 0, kind: Kind = typeKind): Variable => ({
  kind: "variable",
  level,
  typeKind: kind,
});

export const freshRow = (lacks: Iterable<string> = [], level = 0): RowVariable => ({
  kind: "row-variable",
  level,
  lacks: new Set(lacks),
});

export const generic = (name: string, kind: Kind = typeKind): Generic => ({
  kind: "generic",
  name,
  typeKind: kind,
  id: Symbol(name),
});

export const forall = (variables: readonly Generic[], body: Type): Type => ({
  kind: "forall",
  variables,
  body,
});

export const qualified = (predicates: readonly Predicate[], type: Type): Type =>
  predicates.length ? { kind: "qualified", predicates, type } : type;

export const constructorType = (constructor: TypeConstructor): Type => ({
  kind: "constructor",
  constructor,
});

const typeVariable = (value: Type): Variable | null =>
  value.kind === "variable" ? value : null;
const typeInstance = (variable: Variable): Type | undefined => variable.instance;
const linkType = (variable: Variable, instance: Type): void => {
  variable.instance = instance;
};

export const prune = (type: Type): Type =>
  pruneLink(type, typeVariable, typeInstance, linkType);

export const flatten = (input: Row): Row => {
  const fields = new Map(input.fields);
  let tail = input.tail;
  while (tail?.instance) {
    for (const [name, type] of tail.instance.fields) fields.set(name, type);
    tail = tail.instance.tail;
  }
  return row(fields, tail);
};

export const kindOf = (input: Type): Kind => {
  const type = prune(input);
  switch (type.kind) {
    case "variable":
    case "generic":
    case "skolem":
    case "application":
      return type.typeKind;
    case "constructor": {
      let kind: Kind = typeKind;
      for (let i = type.constructor.arity - 1; i >= 0; i--)
        kind = kindArrow(type.constructor.parameters?.[i] ?? typeKind, kind);
      return kind;
    }
    case "forall":
      return kindOf(type.body);
    case "qualified":
      return kindOf(type.type);
    default:
      return typeKind;
  }
};

export const apply = (head: Type, arg: Type): Check<Type> =>
  check(function* () {
    const result = freshKind();
    yield* unifyKinds(kindOf(head), kindArrow(kindOf(arg), result));
    return { kind: "application", fn: head, arg, typeKind: result };
  });

/** Internal convenience; source applications should use apply for diagnostics. */
export const data = (constructor: TypeConstructor, args: readonly Type[]): Type => {
  let type = constructorType(constructor);
  for (const arg of args) {
    const result = run(apply(type, arg));
    if (!result.success) throw new Error(result.error.message);
    type = result.value;
  }
  return type;
};

export const decompose = (input: Type): { head: Type; args: readonly Type[] } => {
  const args: Type[] = [];
  let head = prune(input);
  while (head.kind === "application") {
    args.unshift(head.arg);
    head = prune(head.fn);
  }
  return { head, args };
};

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const rows = new Map<RowVariable, string>();
  const visit = (input: Type): string => {
    const type = prune(input);
    switch (type.kind) {
      case "function":
        return `(${visit(type.param)} -> ${visit(type.result)})`;
      case "constructor":
        return type.constructor.name;
      case "application": {
        const { head, args } = decompose(type);
        return `${visit(head)}(${args.map(visit).join(", ")})`;
      }
      case "qualified":
        return `(${type.predicates.map((p) => `${p.className} ${visit(p.arg)}`).join(", ")} => ${visit(type.type)})`;
      case "forall":
        return `(forall ${type.variables.map((v) => v.name).join(" ")}. ${visit(type.body)})`;
      case "generic":
        return type.name;
      case "skolem":
        return `^${type.name}`;
      case "record": {
        const { fields, tail } = flatten(type.row);
        const labels = [...fields]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([label, field]) => `${label}: ${visit(field)}`);
        if (tail) {
          if (!rows.has(tail)) rows.set(tail, `r${rows.size || ""}`);
          return `{ ${labels.join(", ")}${labels.length ? " " : ""}| ${rows.get(tail)} }`;
        }
        return labels.length ? `{ ${labels.join(", ")} }` : "{}";
      }
      case "variable": {
        if (!names.has(type)) {
          const index = names.size;
          names.set(
            type,
            String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""),
          );
        }
        return names.get(type)!;
      }
      default:
        return type.kind;
    }
  };
  const result = visit(type);
  const constraints = [...rows]
    .filter(([v]) => v.lacks.size)
    .map(([v, name]) => `${name} lacks ${[...v.lacks].sort().join(", ")}`);
  return result + (constraints.length ? ` where ${constraints.join("; ")}` : "");
};

const freeRow = (input: Row, found: Set<FreeVariable>): void => {
  const { fields, tail } = flatten(input);
  for (const type of fields.values()) free(type, found);
  if (tail) found.add(tail);
};

export const free = (input: Type, found = new Set<FreeVariable>()): Set<FreeVariable> => {
  const type = prune(input);
  switch (type.kind) {
    case "variable":
      found.add(type);
      break;
    case "function":
      free(type.param, found);
      free(type.result, found);
      break;
    case "record":
      freeRow(type.row, found);
      break;
    case "application":
      free(type.fn, found);
      free(type.arg, found);
      break;
    case "forall":
      free(type.body, found);
      break;
    case "qualified":
      for (const predicate of type.predicates) free(predicate.arg, found);
      free(type.type, found);
  }
  return found;
};

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
    if (a.kind === "qualified" || b.kind === "qualified")
      return yield* fail("Qualified types require dictionary checking");
    yield* unifyKinds(kindOf(a), kindOf(b));
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      if (b.kind === "forall")
        return yield* fail(
          "Cannot infer an impredicative type; add an explicit polymorphic annotation",
        );
      yield* lower(b, a.level);
      a.instance = b;
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind === "record" && b.kind === "record") yield* unifyRows(a.row, b.row);
    else if (a.kind === "application" && b.kind === "application") {
      yield* unify(a.fn, b.fn);
      yield* unify(a.arg, b.arg);
    } else if (
      a.kind === "constructor" &&
      b.kind === "constructor" &&
      a.constructor.id === b.constructor.id
    )
      return;
    else if (
      a.kind === "forall" &&
      b.kind === "forall" &&
      a.variables.length === b.variables.length
    ) {
      const level = Math.max(maxLevel(a), maxLevel(b)) + 1;
      const ac = instantiate(mono(a));
      const bc = instantiate(mono(b));
      if (ac.kind !== "forall" || bc.kind !== "forall")
        throw new Error("Expected copied quantifier");
      const witnesses: Type[] = [];
      for (let i = 0; i < ac.variables.length; i++) {
        const kind = ac.variables[i]!.typeKind;
        yield* unifyKinds(kind, bc.variables[i]!.typeKind);
        witnesses.push(skolem(ac.variables[i]!.name, level, kind));
      }
      yield* unify(
        substitute(ac.body, new Map(ac.variables.map((v, i) => [v, witnesses[i]!]))),
        substitute(bc.body, new Map(bc.variables.map((v, i) => [v, witnesses[i]!]))),
      );
    } else if (a.kind === "generic" && b.kind === "generic" && a.id === b.id) return;
    else if (a.kind === "skolem" && b.kind === "skolem" && a.id === b.id) return;
    else if (a.kind !== b.kind || !["number", "boolean", "string"].includes(a.kind))
      return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  });

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });

export const generalize = (type: Type, environment: Iterable<Scheme>): Scheme => {
  const variables = free(type);
  for (const scheme of environment)
    for (const variable of free(scheme.type)) {
      if (!scheme.variables.has(variable)) variables.delete(variable);
    }
  return { type, variables };
};

// Kind metavariables belonging to unquantified outer types must stay shared.
// All others are copied with one map, preserving relationships within an instance.
const kindVariables = (input: Kind, found: Set<Kind>): void => {
  const kind = pruneKind(input);
  if (kind.kind === "kind-variable") found.add(kind);
  else if (kind.kind === "arrow") {
    kindVariables(kind.param, found);
    kindVariables(kind.result, found);
  }
};

const cloneKindsFor = (
  type: Type,
  quantified: ReadonlySet<FreeVariable> = new Set(),
): ((kind: Kind) => Kind) => {
  const protectedKinds = new Set<Kind>();
  const visit = (input: Type, bound: ReadonlySet<Generic>): void => {
    const type = prune(input);
    switch (type.kind) {
      case "variable":
        if (!quantified.has(type)) kindVariables(type.typeKind, protectedKinds);
        break;
      case "generic":
        if (!bound.has(type)) kindVariables(type.typeKind, protectedKinds);
        break;
      case "skolem":
        kindVariables(type.typeKind, protectedKinds);
        break;
      case "constructor":
        kindVariables(kindOf(type), protectedKinds);
        break;
      case "application":
        visit(type.fn, bound);
        visit(type.arg, bound);
        break;
      case "function":
        visit(type.param, bound);
        visit(type.result, bound);
        break;
      case "record":
        for (const field of flatten(type.row).fields.values()) visit(field, bound);
        break;
      case "forall":
        visit(type.body, new Set([...bound, ...type.variables]));
        break;
      case "qualified":
        for (const p of type.predicates) visit(p.arg, bound);
        visit(type.type, bound);
        break;
    }
  };
  visit(type, new Set());
  const replacements = new Map<Kind, Kind>();
  const copy = (input: Kind): Kind => {
    const kind = pruneKind(input);
    if (kind.kind === "type" || protectedKinds.has(kind)) return kind;
    if (kind.kind === "arrow") return kindArrow(copy(kind.param), copy(kind.result));
    if (!replacements.has(kind)) replacements.set(kind, freshKind());
    return replacements.get(kind)!;
  };
  return copy;
};

// Rebuilding an application derives its result kind from the substituted head.
const application = (head: Type, arg: Type): Type => {
  const kind = pruneKind(kindOf(head));
  return {
    kind: "application",
    fn: head,
    arg,
    typeKind: kind.kind === "arrow" ? kind.result : freshKind(),
  };
};

export const instantiate = (scheme: Scheme, level = 0): Type => {
  const replacements = new Map<Variable, Variable>();
  const rows = new Map<RowVariable, RowVariable>();
  const copyKind = cloneKindsFor(scheme.type, scheme.variables);
  const visit = (input: Type, generics: ReadonlyMap<Generic, Generic> = new Map()): Type => {
    const type = prune(input);
    switch (type.kind) {
      case "function":
        return fn(visit(type.param, generics), visit(type.result, generics));
      case "application":
        return application(visit(type.fn, generics), visit(type.arg, generics));
      case "qualified":
        return qualified(
          type.predicates.map((p) => ({ className: p.className, arg: visit(p.arg, generics) })),
          visit(type.type, generics),
        );
      case "forall": {
        const nested = new Map(generics);
        const variables = type.variables.map((v) => {
          const replacement = generic(v.name, copyKind(v.typeKind));
          nested.set(v, replacement);
          return replacement;
        });
        return forall(variables, visit(type.body, nested));
      }
      case "generic":
        return generics.get(type) ?? type;
      case "record": {
        const flat = flatten(type.row);
        let tail = flat.tail;
        if (tail && scheme.variables.has(tail)) {
          if (!rows.has(tail)) rows.set(tail, freshRow(tail.lacks, level));
          tail = rows.get(tail)!;
        }
        return record(
          row(
            new Map([...flat.fields].map(([name, field]) => [name, visit(field, generics)])),
            tail,
          ),
        );
      }
      case "variable":
        if (!scheme.variables.has(type)) return type;
        if (!replacements.has(type)) replacements.set(type, fresh(level, copyKind(type.typeKind)));
        return replacements.get(type)!;
      default:
        return type;
    }
  };
  return visit(scheme.type);
};

// Lexical levels prevent an outer type or row meta acquiring an inner skolem.
const lower = (input: Type, level: number, bound: ReadonlySet<Generic> = new Set()): Check<void> =>
  check(function* () {
    const type = prune(input);
    switch (type.kind) {
      case "variable":
        type.level = Math.min(type.level, level);
        return;
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
      case "application":
        yield* lower(type.fn, level, bound);
        yield* lower(type.arg, level, bound);
        return;
      case "qualified":
        for (const predicate of type.predicates) yield* lower(predicate.arg, level, bound);
        yield* lower(type.type, level, bound);
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

const maxLevel = (input: Type): number => {
  const type = prune(input);
  switch (type.kind) {
    case "variable":
    case "skolem":
      return type.level;
    case "function":
      return Math.max(maxLevel(type.param), maxLevel(type.result));
    case "application":
      return Math.max(maxLevel(type.fn), maxLevel(type.arg));
    case "qualified":
      return Math.max(maxLevel(type.type), ...type.predicates.map((p) => maxLevel(p.arg)));
    case "forall":
      return maxLevel(type.body);
    case "record": {
      const { fields, tail } = flatten(type.row);
      return Math.max(tail?.level ?? 0, ...[...fields.values()].map(maxLevel));
    }
    default:
      return 0;
  }
};

const freeGenerics = (
  input: Type,
  found = new Set<Generic>(),
  bound: ReadonlySet<Generic> = new Set(),
): Set<Generic> => {
  const type = prune(input);
  switch (type.kind) {
    case "generic":
      if (!bound.has(type)) found.add(type);
      break;
    case "function":
      freeGenerics(type.param, found, bound);
      freeGenerics(type.result, found, bound);
      break;
    case "application":
      freeGenerics(type.fn, found, bound);
      freeGenerics(type.arg, found, bound);
      break;
    case "qualified":
      for (const predicate of type.predicates) freeGenerics(predicate.arg, found, bound);
      freeGenerics(type.type, found, bound);
      break;
    case "forall":
      freeGenerics(type.body, found, new Set([...bound, ...type.variables]));
      break;
    case "record":
      for (const field of flatten(type.row).fields.values()) freeGenerics(field, found, bound);
      break;
  }
  return found;
};

/** Capture-avoiding substitution; replacement types must have the binder's kind. */
export const substitute = (input: Type, replacements: ReadonlyMap<Generic, Type>): Type => {
  const type = prune(input);
  switch (type.kind) {
    case "generic":
      return replacements.get(type) ?? type;
    case "function":
      return fn(substitute(type.param, replacements), substitute(type.result, replacements));
    case "application":
      return application(substitute(type.fn, replacements), substitute(type.arg, replacements));
    case "qualified":
      return qualified(
        type.predicates.map((p) => ({
          className: p.className,
          arg: substitute(p.arg, replacements),
        })),
        substitute(type.type, replacements),
      );
    case "record": {
      const { fields, tail } = flatten(type.row);
      return record(
        row(
          new Map([...fields].map(([name, field]) => [name, substitute(field, replacements)])),
          tail,
        ),
      );
    }
    case "forall": {
      const local = new Map(replacements);
      for (const variable of type.variables) local.delete(variable);
      const captures = new Set<Generic>();
      for (const replacement of local.values()) freeGenerics(replacement, captures);
      const renaming = new Map<Generic, Type>();
      const variables = type.variables.map((variable) => {
        if (!captures.has(variable)) return variable;
        const renamed = generic(variable.name, variable.typeKind);
        renaming.set(variable, renamed);
        return renamed;
      });
      const body = renaming.size ? substitute(type.body, renaming) : type.body;
      return forall(variables, substitute(body, local));
    }
    default:
      return type;
  }
};

export const instantiateForall = (input: Type, level = 0): Type => {
  let type = prune(instantiate(mono(input), level));
  while (type.kind === "forall") {
    type = prune(
      substitute(
        type.body,
        new Map(type.variables.map((variable) => [variable, fresh(level, variable.typeKind)])),
      ),
    );
  }
  return type;
};

const skolem = (name: string, level: number, kind: Kind): Type => ({
  kind: "skolem",
  name,
  level,
  typeKind: kind,
  id: Symbol(name),
});

export const skolemize = (input: Type, level: number): Type => {
  let type = prune(instantiate(mono(input), level));
  while (type.kind === "forall") {
    type = prune(
      substitute(
        type.body,
        new Map(
          type.variables.map((variable) => [
            variable,
            skolem(variable.name, level, variable.typeKind),
          ]),
        ),
      ),
    );
  }
  return type;
};

export const subsume = (actual: Type, expected: Type, level = 0): Check<void> =>
  check(function* () {
    const target = prune(expected);
    if (target.kind === "qualified")
      return yield* fail("Qualified types require dictionary checking");
    if (target.kind === "forall") {
      yield* subsume(instantiateForall(actual, level + 1), skolemize(target, level + 1), level + 1);
      return;
    }
    const source = instantiateForall(actual, level);
    if (source.kind === "qualified")
      return yield* fail("Qualified types require dictionary checking");
    if (source.kind === "function" && target.kind === "function") {
      yield* subsume(target.param, source.param, level);
      yield* subsume(source.result, target.result, level);
    } else yield* unify(source, target);
  });

/** Read-only identity/structure comparison for dictionary selection, never inference. */
export const sameType = (left: Type, right: Type): boolean => {
  const deref = (input: Type): Type => {
    let type = input;
    while (type.kind === "variable" && type.instance) type = type.instance;
    return type;
  };
  const a = deref(left);
  const b = deref(right);
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "number":
    case "boolean":
    case "string":
      return true;
    case "variable":
      return false;
    case "generic":
      return b.kind === "generic" && a.id === b.id;
    case "skolem":
      return b.kind === "skolem" && a.id === b.id;
    case "constructor":
      return b.kind === "constructor" && a.constructor.id === b.constructor.id;
    case "application":
      return b.kind === "application" && sameType(a.fn, b.fn) && sameType(a.arg, b.arg);
    case "function":
      return b.kind === "function" && sameType(a.param, b.param) && sameType(a.result, b.result);
    case "forall":
      return (
        b.kind === "forall" &&
        a.variables.length === b.variables.length &&
        a.variables.every((v, i) => v.id === b.variables[i]!.id) &&
        sameType(a.body, b.body)
      );
    case "qualified":
      return (
        b.kind === "qualified" &&
        a.predicates.length === b.predicates.length &&
        a.predicates.every(
          (p, i) =>
            p.className === b.predicates[i]!.className && sameType(p.arg, b.predicates[i]!.arg),
        ) &&
        sameType(a.type, b.type)
      );
    case "record": {
      if (b.kind !== "record") return false;
      const ar = flatten(a.row);
      const br = flatten(b.row);
      return (
        ar.tail === br.tail &&
        ar.fields.size === br.fields.size &&
        [...ar.fields].every(
          ([name, type]) => br.fields.has(name) && sameType(type, br.fields.get(name)!),
        )
      );
    }
  }
};
