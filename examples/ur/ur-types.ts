import { check, fail, type Check } from "langkit";
import type { TypeExpr } from "./ur-syntax.ts";

export type Parameter = { readonly id: symbol; readonly name: string; readonly row: boolean };
export type Row = {
  readonly fields: ReadonlyMap<string, Type>;
  readonly variables: readonly Parameter[];
};
export type Constraint = { readonly left: Row; readonly right: Row };
export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "variable"; readonly parameter: Parameter }
  | { readonly kind: "record"; readonly row: Row }
  | {
      readonly kind: "function";
      readonly params: readonly Type[];
      readonly result: Type;
      readonly generics: readonly Parameter[];
      readonly constraints: readonly Constraint[];
    };
export type FunctionType = Extract<Type, { kind: "function" }>;
export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };
export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  variables: readonly Parameter[] = [],
): Row => ({ fields, variables });
export const record = (row: Row): Type => ({ kind: "record", row });
export const fn = (
  params: readonly Type[],
  result: Type,
  generics: readonly Parameter[] = [],
  constraints: readonly Constraint[] = [],
): FunctionType => ({ kind: "function", params, result, generics, constraints });
const showRow = (row: Row): string =>
  [
    ...(row.fields.size
      ? [`{ ${[...row.fields].map(([name, type]) => `${name}: ${show(type)}`).join(", ")} }`]
      : []),
    ...row.variables.map((variable) => variable.name),
  ].join(" ++ ") || "{}";
export const show = (type: Type): string => {
  switch (type.kind) {
    case "variable":
      return type.parameter.name;
    case "record":
      return type.row.variables.length ? `Record<${showRow(type.row)}>` : showRow(type.row);
    case "function":
      return `${type.generics.length ? `<${type.generics.map((p) => `${p.name}${p.row ? ": Row<Type>" : ""}`).join(", ")}>` : ""}(${type.params.map(show).join(", ")}) -> ${show(type.result)}${type.constraints.length ? ` where ${type.constraints.map((c) => `disjoint(${showRow(c.left)}, ${showRow(c.right)})`).join(", ")}` : ""}`;
    default:
      return type.kind;
  }
};
export const sameRow = (a: Row, b: Row): boolean =>
  a.fields.size === b.fields.size &&
  a.variables.length === b.variables.length &&
  [...a.fields].every(([name, type]) => b.fields.has(name) && same(type, b.fields.get(name)!)) &&
  a.variables.every((v) => b.variables.some((w) => v.id === w.id));
export const same = (a: Type, b: Type): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "variable" && b.kind === "variable") return a.parameter.id === b.parameter.id;
  if (a.kind === "record" && b.kind === "record") return sameRow(a.row, b.row);
  if (a.kind === "function" && b.kind === "function")
    return (
      a.generics.length === b.generics.length &&
      a.generics.every((p, i) => p.id === b.generics[i]!.id) &&
      a.constraints.length === b.constraints.length &&
      a.constraints.every(
        (c, i) =>
          sameRow(c.left, b.constraints[i]!.left) && sameRow(c.right, b.constraints[i]!.right),
      ) &&
      a.params.length === b.params.length &&
      a.params.every((p, i) => same(p, b.params[i]!)) &&
      same(a.result, b.result)
    );
  return true;
};
export const expect = (actual: Type, expected: Type): Check<void> =>
  check(function* () {
    if (!same(actual, expected)) yield* fail(`Expected ${show(expected)}, found ${show(actual)}`);
  });

// A row is a disjoint union of known labels and rigid unknown rows. A hypothesis
// about unions implies disjointness of each pair of components, never equality.
type Component = string | symbol;
const components = (r: Row): Component[] => [...r.fields.keys(), ...r.variables.map((v) => v.id)];
const proves = (a: Component, b: Component, constraints: readonly Constraint[]): boolean => {
  if (typeof a === "string" && typeof b === "string") return a !== b;
  return constraints.some((c) => {
    const left = components(c.left),
      right = components(c.right);
    return (left.includes(a) && right.includes(b)) || (left.includes(b) && right.includes(a));
  });
};
export const disjoint = (a: Row, b: Row, constraints: readonly Constraint[]): Check<void> =>
  check(function* () {
    for (const x of components(a))
      for (const y of components(b)) {
        if (x === y)
          return yield* fail(
            typeof x === "string"
              ? `Overlapping field: ${x}`
              : "Cannot concatenate a row with itself",
          );
        if (!proves(x, y, constraints))
          return yield* fail(
            `Cannot prove disjoint(${showRow(a)}, ${showRow(b)}); add a disjoint constraint`,
          );
      }
  });
export const concat = (a: Row, b: Row, constraints: readonly Constraint[]): Check<Row> =>
  check(function* () {
    yield* disjoint(a, b, constraints);
    return row(new Map([...a.fields, ...b.fields]), [...a.variables, ...b.variables]);
  });

export type TypeScope = ReadonlyMap<string, Parameter>;
export const resolveRow = (
  expr: TypeExpr,
  scope: TypeScope,
  constraints: readonly Constraint[],
): Check<Row> =>
  check(function* () {
    if (expr.kind === "name") {
      const variable = scope.get(expr.name);
      if (!variable) return yield* fail(`Unknown row: ${expr.name}`);
      if (!variable.row)
        return yield* fail(`Expected Row<Type>, found Type parameter ${expr.name}`);
      return row(new Map(), [variable]);
    }
    if (expr.kind === "concat")
      return yield* concat(
        yield* resolveRow(expr.left, scope, constraints),
        yield* resolveRow(expr.right, scope, constraints),
        constraints,
      );
    if (expr.kind === "record") {
      const fields = new Map<string, Type>();
      for (const field of expr.fields) {
        if (fields.has(field.name.name))
          return yield* fail(`Duplicate field: ${field.name.name}`).at(field.name.span);
        fields.set(field.name.name, yield* resolve(field.type, scope, constraints));
      }
      return row(fields);
    }
    return yield* fail("Expected a row (Row<Type>)");
  }).at(expr.span);
export const resolve = (
  expr: TypeExpr,
  scope: TypeScope,
  constraints: readonly Constraint[],
): Check<Type> =>
  check(function* () {
    switch (expr.kind) {
      case "name": {
        if (expr.name === "number") return number;
        if (expr.name === "boolean") return boolean;
        if (expr.name === "string") return string;
        const parameter = scope.get(expr.name);
        if (!parameter) return yield* fail(`Unknown type: ${expr.name}`);
        if (parameter.row)
          return yield* fail(
            `Expected Type, found Row<Type> parameter ${expr.name}; use Record<${expr.name}>`,
          );
        return { kind: "variable" as const, parameter };
      }
      case "record":
        return record(yield* resolveRow(expr, scope, constraints));
      case "record-of":
        return record(yield* resolveRow(expr.row, scope, constraints));
      case "function":
        return fn(
          [yield* resolve(expr.param, scope, constraints)],
          yield* resolve(expr.result, scope, constraints),
        );
      case "concat":
        return yield* fail("Row concatenation is not a Type; use Record<A ++ B>");
    }
  }).at(expr.span);

// Call-site inference only substitutes the callee's quantified parameters. The
// caller's generic parameters stay rigid. No body is specialized or rechecked.
type Substitution = { types: Map<symbol, Type>; rows: Map<symbol, Row> };
const substituteRow = (
  r: Row,
  sub: Substitution,
  constraints: readonly Constraint[],
  bound: ReadonlySet<symbol>,
): Check<Row> =>
  check(function* () {
    const fields = new Map<string, Type>();
    for (const [name, type] of r.fields)
      fields.set(name, yield* substitute(type, sub, constraints, bound));
    let result = row(fields);
    for (const variable of r.variables) {
      const replacement = sub.rows.get(variable.id);
      if (!replacement && bound.has(variable.id))
        return yield* fail(`Cannot infer row parameter ${variable.name}`);
      result = yield* concat(result, replacement ?? row(new Map(), [variable]), constraints);
    }
    return result;
  });
const substitute = (
  type: Type,
  sub: Substitution,
  constraints: readonly Constraint[],
  bound: ReadonlySet<symbol>,
): Check<Type> =>
  check(function* () {
    if (type.kind === "variable") {
      const replacement = sub.types.get(type.parameter.id);
      if (!replacement && bound.has(type.parameter.id))
        return yield* fail(`Cannot infer type parameter ${type.parameter.name}`);
      return replacement ?? type;
    }
    if (type.kind === "record")
      return record(yield* substituteRow(type.row, sub, constraints, bound));
    if (type.kind === "function") {
      const params: Type[] = [];
      for (const p of type.params) params.push(yield* substitute(p, sub, constraints, bound));
      return fn(
        params,
        yield* substitute(type.result, sub, constraints, bound),
        type.generics,
        type.constraints,
      );
    }
    return type;
  });
const matchRow = (
  pattern: Row,
  actual: Row,
  bound: ReadonlySet<symbol>,
  sub: Substitution,
): Check<void> =>
  check(function* () {
    const fields = new Map(actual.fields);
    for (const [name, type] of pattern.fields) {
      const found = fields.get(name);
      if (!found) return yield* fail(`Missing field: ${name}`);
      yield* match(type, found, bound, sub);
      fields.delete(name);
    }
    const variables = [...actual.variables];
    const unknown: Parameter[] = [];
    // Subtract rigid and already inferred components; infer a single residual row.
    for (const p of pattern.variables) {
      if (bound.has(p.id) && !sub.rows.has(p.id)) {
        unknown.push(p);
        continue;
      }
      const known = sub.rows.get(p.id) ?? row(new Map(), [p]);
      for (const [name, type] of known.fields) {
        const found = fields.get(name);
        if (!found) return yield* fail(`Missing field: ${name}`);
        yield* expect(found, type);
        fields.delete(name);
      }
      for (const v of known.variables) {
        const index = variables.findIndex((w) => w.id === v.id);
        if (index < 0) return yield* fail(`Expected rigid row ${v.name}`);
        variables.splice(index, 1);
      }
    }
    if (unknown.length > 1)
      return yield* fail(
        "Ambiguous row decomposition; infer each row from a separate argument first",
      );
    if (unknown.length === 1) sub.rows.set(unknown[0]!.id, row(fields, variables));
    else if (fields.size || variables.length)
      return yield* fail("Record rows do not match (unexpected fields or row parameters)");
  });
const match = (
  pattern: Type,
  actual: Type,
  bound: ReadonlySet<symbol>,
  sub: Substitution,
): Check<void> =>
  check(function* () {
    if (pattern.kind === "variable" && bound.has(pattern.parameter.id)) {
      const previous = sub.types.get(pattern.parameter.id);
      if (previous) yield* expect(actual, previous);
      else {
        // This subset is rank one: a type parameter cannot hide a forall.
        if (polymorphic(actual))
          return yield* fail(
            "Polymorphic values cannot be passed as generic arguments; use a monomorphic wrapper",
          );
        sub.types.set(pattern.parameter.id, actual);
      }
      return;
    }
    if (pattern.kind === "record" && actual.kind === "record")
      return yield* matchRow(pattern.row, actual.row, bound, sub);
    if (pattern.kind === "function" && actual.kind === "function") {
      if (
        actual.generics.length ||
        pattern.generics.length ||
        actual.params.length !== pattern.params.length
      )
        return yield* fail("Expected a monomorphic function with matching arity");
      for (let i = 0; i < pattern.params.length; i++)
        yield* match(pattern.params[i]!, actual.params[i]!, bound, sub);
      yield* match(pattern.result, actual.result, bound, sub);
      return;
    }
    yield* expect(actual, pattern);
  });
const polymorphic = (type: Type): boolean =>
  type.kind === "function"
    ? !!type.generics.length || type.params.some(polymorphic) || polymorphic(type.result)
    : type.kind === "record" && [...type.row.fields.values()].some(polymorphic);
export const apply = (
  callee: FunctionType,
  args: readonly Type[],
  assumptions: readonly Constraint[],
): Check<Type> =>
  check(function* () {
    if (args.length !== callee.params.length)
      return yield* fail(`Expected ${callee.params.length} arguments, found ${args.length}`);
    const bound = new Set(callee.generics.map((p) => p.id));
    const sub: Substitution = { types: new Map(), rows: new Map() };
    for (let i = 0; i < args.length; i++) yield* match(callee.params[i]!, args[i]!, bound, sub);
    for (const c of callee.constraints) {
      const left = yield* substituteRow(c.left, sub, assumptions, bound);
      const right = yield* substituteRow(c.right, sub, assumptions, bound);
      yield* disjoint(left, right, assumptions);
    }
    // Revalidate substituted parameter rows: matching a residual row must not
    // silently discard the disjointness obligations in a parameter annotation.
    for (let i = 0; i < args.length; i++)
      yield* expect(args[i]!, yield* substitute(callee.params[i]!, sub, assumptions, bound));
    return yield* substitute(callee.result, sub, assumptions, bound);
  });
