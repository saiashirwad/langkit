import { check, fail, type Check } from "langkit";
import type { Generic, KindExpr, TypeExpr } from "./ur-syntax.ts";

export type Kind = KindExpr;

export const typeKind: Kind = { kind: "type" };
export const rowKind = (element: Kind = typeKind): Kind => ({ kind: "row", element });
export const arrowKind = (param: Kind, result: Kind): Kind => ({ kind: "arrow", param, result });

export const sameKind = (a: Kind, b: Kind): boolean =>
  a.kind === b.kind &&
  (a.kind === "type" ||
    (a.kind === "row" && b.kind === "row" && sameKind(a.element, b.element)) ||
    (a.kind === "arrow" &&
      b.kind === "arrow" &&
      sameKind(a.param, b.param) &&
      sameKind(a.result, b.result)));

export const showKind = (kind: Kind): string => {
  if (kind.kind === "type") return "Type";
  if (kind.kind === "row") return `Row<${showKind(kind.element)}>`;
  return `(${showKind(kind.param)} -> ${showKind(kind.result)})`;
};

export type Parameter = { readonly id: symbol; readonly name: string; readonly typeKind: Kind };

// A neutral row retains its original field-name set under mapping. The mapper
// affects payloads only; it must never change disjointness or manufacture labels.
export type RowPart = { readonly base: Type; readonly mapper: Type | undefined };

export type Row = {
  readonly element: Kind;
  readonly fields: ReadonlyMap<string, Type>;
  readonly variables: readonly RowPart[];
};

export type Constraint = { readonly left: Row; readonly right: Row };

// Constructors and runtime types share a representation. Only constructors of
// kind Type may appear on runtime values. Aliases reduce to constructor lambdas,
// not nominal heads, so their arguments are never assumed injective.
export type Type =
  | { readonly kind: "number" | "boolean" | "string" }
  | { readonly kind: "variable"; readonly parameter: Parameter }
  | { readonly kind: "record"; readonly row: Row }
  | { readonly kind: "folder"; readonly row: Row }
  | { readonly kind: "row-value"; readonly row: Row }
  | { readonly kind: "constructor-lambda"; readonly parameter: Parameter; readonly body: Type }
  | { readonly kind: "application"; readonly fn: Type; readonly arg: Type; readonly typeKind: Kind }
  | {
      readonly kind: "function";
      readonly params: readonly Type[];
      readonly result: Type;
      readonly generics: readonly Parameter[];
      readonly constraints: readonly Constraint[];
    };

export type FunctionType = Extract<Type, { kind: "function" }>;
export type TypeScope = ReadonlyMap<string, Type>;

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };
export const variable = (parameter: Parameter): Type => ({ kind: "variable", parameter });

export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  variables: readonly RowPart[] = [],
  element: Kind = typeKind,
): Row => ({ fields, variables, element });

export const record = (row: Row): Type => ({ kind: "record", row });
export const folder = (row: Row): Type => ({ kind: "folder", row });
const rowValue = (row: Row): Type => ({ kind: "row-value", row });

export const fn = (
  params: readonly Type[],
  result: Type,
  generics: readonly Parameter[] = [],
  constraints: readonly Constraint[] = [],
): FunctionType => ({ kind: "function", params, result, generics, constraints });

export const kindOf = (type: Type): Kind => {
  switch (type.kind) {
    case "variable":
      return type.parameter.typeKind;
    case "application":
      return type.typeKind;
    case "constructor-lambda":
      return arrowKind(type.parameter.typeKind, kindOf(type.body));
    case "row-value":
      return rowKind(type.row.element);
    default:
      return typeKind;
  }
};

const expectKind = (actual: Kind, expected: Kind): Check<void> =>
  check(function* () {
    if (!sameKind(actual, expected))
      yield* fail(`Expected ${showKind(expected)}, found ${showKind(actual)}`);
  });

const showRow = (r: Row): string =>
  [
    ...(r.fields.size
      ? [`{ ${[...r.fields].map(([name, type]) => `${name}: ${show(type)}`).join(", ")} }`]
      : []),
    ...r.variables.map(({ base, mapper }) =>
      mapper ? `Map<${show(mapper)}, ${show(base)}>` : show(base),
    ),
  ].join(" ++ ") || "{}";

export const show = (type: Type): string => {
  switch (type.kind) {
    case "variable":
      return type.parameter.name;
    case "record":
      return type.row.variables.length ? `Record<${showRow(type.row)}>` : showRow(type.row);
    case "folder":
      return `Folder<${showRow(type.row)}>`;
    case "row-value":
      return showRow(type.row);
    case "constructor-lambda":
      return `(type ${type.parameter.name}: ${showKind(type.parameter.typeKind)} => ${show(type.body)})`;
    case "application":
      return `${show(type.fn)}<${show(type.arg)}>`;
    case "function":
      return `${type.generics.length ? `<${type.generics.map((p) => `${p.name}${p.typeKind.kind === "type" ? "" : `: ${showKind(p.typeKind)}`}`).join(", ")}>` : ""}(${type.params.map(show).join(", ")}) -> ${show(type.result)}${type.constraints.length ? ` where ${type.constraints.map((c) => `disjoint(${showRow(c.left)}, ${showRow(c.right)})`).join(", ")}` : ""}`;
    default:
      return type.kind;
  }
};

type Renaming = ReadonlyMap<symbol, symbol>;

const equalPart = (a: RowPart, b: RowPart, names: Renaming): boolean =>
  equal(a.base, b.base, names) &&
  (a.mapper === undefined
    ? b.mapper === undefined
    : b.mapper !== undefined && equal(a.mapper, b.mapper, names));

const equalRow = (a: Row, b: Row, names: Renaming): boolean =>
  sameKind(a.element, b.element) &&
  a.fields.size === b.fields.size &&
  a.variables.length === b.variables.length &&
  [...a.fields].every(
    ([name, type]) => b.fields.has(name) && equal(type, b.fields.get(name)!, names),
  ) &&
  a.variables.every((part) => b.variables.some((other) => equalPart(part, other, names)));

const equal = (a: Type, b: Type, names: Renaming): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "variable":
      return (
        b.kind === "variable" && (names.get(a.parameter.id) ?? a.parameter.id) === b.parameter.id
      );
    case "record":
    case "folder":
    case "row-value":
      return (
        (b.kind === "record" || b.kind === "folder" || b.kind === "row-value") &&
        equalRow(a.row, b.row, names)
      );
    case "application":
      return b.kind === "application" && equal(a.fn, b.fn, names) && equal(a.arg, b.arg, names);
    case "constructor-lambda":
      return (
        b.kind === "constructor-lambda" &&
        sameKind(a.parameter.typeKind, b.parameter.typeKind) &&
        equal(a.body, b.body, new Map(names).set(a.parameter.id, b.parameter.id))
      );
    case "function": {
      if (
        b.kind !== "function" ||
        a.generics.length !== b.generics.length ||
        a.params.length !== b.params.length ||
        a.constraints.length !== b.constraints.length
      )
        return false;
      const inner = new Map(names);
      for (let i = 0; i < a.generics.length; i++) {
        const left = a.generics[i]!,
          right = b.generics[i]!;
        if (!sameKind(left.typeKind, right.typeKind)) return false;
        inner.set(left.id, right.id);
      }
      return (
        a.params.every((p, i) => equal(p, b.params[i]!, inner)) &&
        equal(a.result, b.result, inner) &&
        a.constraints.every(
          (c, i) =>
            equalRow(c.left, b.constraints[i]!.left, inner) &&
            equalRow(c.right, b.constraints[i]!.right, inner),
        )
      );
    }
    default:
      return true;
  }
};

export const same = (a: Type, b: Type): boolean => equal(a, b, new Map());
export const sameRow = (a: Row, b: Row): boolean => equalRow(a, b, new Map());

export const expect = (actual: Type, expected: Type): Check<void> =>
  check(function* () {
    if (!same(actual, expected)) yield* fail(`Expected ${show(expected)}, found ${show(actual)}`);
  });

type Component = string | Type;
const components = (r: Row): Component[] => [...r.fields.keys(), ...r.variables.map((v) => v.base)];
const sameComponent = (a: Component, b: Component): boolean =>
  typeof a === "string" ? a === b : typeof b !== "string" && same(a, b);

const proves = (a: Component, b: Component, constraints: readonly Constraint[]): boolean => {
  if (typeof a === "string" && typeof b === "string") return a !== b;
  const contains = (r: Row, x: Component) => components(r).some((y) => sameComponent(x, y));
  return constraints.some(
    (c) =>
      (contains(c.left, a) && contains(c.right, b)) ||
      (contains(c.left, b) && contains(c.right, a)),
  );
};

export const disjoint = (a: Row, b: Row, constraints: readonly Constraint[]): Check<void> =>
  check(function* () {
    for (const x of components(a))
      for (const y of components(b)) {
        if (sameComponent(x, y))
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
    yield* expectKind(a.element, b.element);
    yield* disjoint(a, b, constraints);
    return row(new Map([...a.fields, ...b.fields]), [...a.variables, ...b.variables], a.element);
  });

const asRow = (type: Type): Check<Row> =>
  check(function* () {
    if (type.kind === "row-value") return type.row;
    const kind = kindOf(type);
    if (kind.kind !== "row") return yield* fail(`Expected Row<Type>, found ${showKind(kind)}`);
    return row(new Map(), [{ base: type, mapper: undefined }], kind.element);
  });

const occurs = (id: symbol, type: Type): boolean => {
  switch (type.kind) {
    case "variable":
      return type.parameter.id === id;
    case "application":
      return occurs(id, type.fn) || occurs(id, type.arg);
    case "constructor-lambda":
      return type.parameter.id !== id && occurs(id, type.body);
    case "row-value":
    case "record":
    case "folder":
      return occursRow(id, type.row);
    case "function":
      return (
        !type.generics.some((p) => p.id === id) &&
        (type.params.some((p) => occurs(id, p)) ||
          occurs(id, type.result) ||
          type.constraints.some((c) => occursRow(id, c.left) || occursRow(id, c.right)))
      );
    default:
      return false;
  }
};

const occursRow = (id: symbol, r: Row): boolean =>
  [...r.fields.values()].some((t) => occurs(id, t)) ||
  r.variables.some((v) => occurs(id, v.base) || (v.mapper !== undefined && occurs(id, v.mapper)));

// Eta contraction gives every mapper a stable identity, including aliases such
// as type Identity<A> = A and type Apply<F, A> = F<A>.
const abstraction = (parameter: Parameter, body: Type): Type => {
  if (
    body.kind === "application" &&
    body.arg.kind === "variable" &&
    body.arg.parameter.id === parameter.id &&
    !occurs(parameter.id, body.fn)
  )
    return body.fn;
  return { kind: "constructor-lambda", parameter, body };
};

const identityMapper = (mapper: Type): boolean =>
  mapper.kind === "constructor-lambda" &&
  mapper.body.kind === "variable" &&
  mapper.body.parameter.id === mapper.parameter.id;

type Substitution = ReadonlyMap<symbol, Type>;

const constructorApply = (
  callee: Type,
  arg: Type,
  assumptions: readonly Constraint[],
): Check<Type> =>
  check(function* () {
    const kind = kindOf(callee);
    if (kind.kind !== "arrow")
      return yield* fail(`Cannot apply ${show(callee)} of kind ${showKind(kind)}`);
    yield* expectKind(kindOf(arg), kind.param);
    if (callee.kind === "constructor-lambda")
      return yield* substitute(
        callee.body,
        new Map([[callee.parameter.id, arg]]),
        assumptions,
        new Set(),
      );
    return { kind: "application" as const, fn: callee, arg, typeKind: kind.result };
  });

const compose = (outer: Type, inner: Type, assumptions: readonly Constraint[]): Check<Type> =>
  check(function* () {
    const kind = kindOf(inner);
    if (kind.kind !== "arrow") return yield* fail("Expected a type-level function");
    const parameter: Parameter = { id: Symbol("item"), name: "item", typeKind: kind.param };
    return abstraction(
      parameter,
      yield* constructorApply(
        outer,
        yield* constructorApply(inner, variable(parameter), assumptions),
        assumptions,
      ),
    );
  });

export const mapRow = (mapper: Type, source: Row, assumptions: readonly Constraint[]): Check<Row> =>
  check(function* () {
    const kind = kindOf(mapper);
    if (kind.kind !== "arrow") return yield* fail("Map requires a type-level function");
    yield* expectKind(source.element, kind.param);
    if (identityMapper(mapper)) return source;
    const fields = new Map<string, Type>();
    for (const [name, type] of source.fields)
      fields.set(name, yield* constructorApply(mapper, type, assumptions));
    const variables: RowPart[] = [];
    for (const part of source.variables) {
      const combined = part.mapper ? yield* compose(mapper, part.mapper, assumptions) : mapper;
      variables.push({ base: part.base, mapper: identityMapper(combined) ? undefined : combined });
    }
    return row(fields, variables, kind.result);
  });

const substituteRow = (
  r: Row,
  sub: Substitution,
  assumptions: readonly Constraint[],
  bound: ReadonlySet<symbol>,
): Check<Row> =>
  check(function* () {
    const fields = new Map<string, Type>();
    for (const [name, type] of r.fields)
      fields.set(name, yield* substitute(type, sub, assumptions, bound));
    let result = row(fields, [], r.element);
    for (const part of r.variables) {
      let replacement = yield* asRow(yield* substitute(part.base, sub, assumptions, bound));
      if (part.mapper)
        replacement = yield* mapRow(
          yield* substitute(part.mapper, sub, assumptions, bound),
          replacement,
          assumptions,
        );
      result = yield* concat(result, replacement, assumptions);
    }
    return result;
  });

const substitute = (
  type: Type,
  sub: Substitution,
  assumptions: readonly Constraint[],
  bound: ReadonlySet<symbol>,
): Check<Type> =>
  check(function* () {
    switch (type.kind) {
      case "variable": {
        const replacement = sub.get(type.parameter.id);
        if (!replacement && bound.has(type.parameter.id))
          return yield* fail(
            `Cannot infer ${type.parameter.typeKind.kind === "row" ? "row" : "type"} parameter ${type.parameter.name}; supply explicit type arguments`,
          );
        return replacement ?? type;
      }
      case "record":
        return record(yield* substituteRow(type.row, sub, assumptions, bound));
      case "folder":
        return folder(yield* substituteRow(type.row, sub, assumptions, bound));
      case "row-value":
        return rowValue(yield* substituteRow(type.row, sub, assumptions, bound));
      case "application":
        return yield* constructorApply(
          yield* substitute(type.fn, sub, assumptions, bound),
          yield* substitute(type.arg, sub, assumptions, bound),
          assumptions,
        );
      case "constructor-lambda": {
        const inner = new Map(sub);
        inner.delete(type.parameter.id);
        return abstraction(type.parameter, yield* substitute(type.body, inner, assumptions, bound));
      }
      case "function": {
        const inner = new Map(sub);
        for (const p of type.generics) inner.delete(p.id);
        const params: Type[] = [];
        for (const p of type.params) params.push(yield* substitute(p, inner, assumptions, bound));
        const constraints: Constraint[] = [];
        for (const c of type.constraints)
          constraints.push({
            left: yield* substituteRow(c.left, inner, assumptions, bound),
            right: yield* substituteRow(c.right, inner, assumptions, bound),
          });
        return fn(
          params,
          yield* substitute(type.result, inner, assumptions, bound),
          type.generics,
          constraints,
        );
      }
      default:
        return type;
    }
  });

// Record literals are context-directed: {x: T} denotes a Type by default, but a
// row in Record<...>, Map's row argument, a row constraint, or a Row<k> argument.
export const resolveConstructor = (
  expr: TypeExpr,
  scope: TypeScope,
  assumptions: readonly Constraint[],
  expected?: Kind,
): Check<Type> =>
  check(function* () {
    let result: Type;
    switch (expr.kind) {
      case "name": {
        const found =
          expr.name === "number"
            ? number
            : expr.name === "boolean"
              ? boolean
              : expr.name === "string"
                ? string
                : scope.get(expr.name);
        if (!found)
          return yield* fail(
            `Unknown type: ${expr.name} (aliases must refer to earlier declarations; recursive aliases are not supported)`,
          );
        result = found;
        break;
      }
      case "record": {
        const element = expected?.kind === "row" ? expected.element : typeKind;
        const fields = new Map<string, Type>();
        for (const field of expr.fields) {
          if (fields.has(field.name.name))
            return yield* fail(`Duplicate field: ${field.name.name}`).at(field.name.span);
          fields.set(
            field.name.name,
            yield* resolveConstructor(field.type, scope, assumptions, element),
          );
        }
        const r = row(fields, [], element);
        result = expected?.kind === "row" ? rowValue(r) : record(r);
        break;
      }
      case "record-of":
        result = record(yield* resolveRow(expr.row, scope, assumptions));
        break;
      case "folder-of":
        result = folder(yield* resolveRow(expr.row, scope, assumptions));
        break;
      case "forall": {
        if (!expr.generics.length) return yield* fail("forall requires at least one parameter");
        const inner = yield* bindGenerics(expr.generics, scope);
        const body = yield* resolve(expr.body, inner.scope, assumptions);
        if (body.kind !== "function" || body.generics.length)
          return yield* fail("forall must quantify a function type");
        result = fn(body.params, body.result, inner.parameters, body.constraints);
        break;
      }
      case "function": {
        const params: Type[] = [];
        for (const param of expr.params) params.push(yield* resolve(param, scope, assumptions));
        result = fn(params, yield* resolve(expr.result, scope, assumptions));
        break;
      }
      case "concat": {
        const kind = expected?.kind === "row" ? expected : rowKind();
        result = rowValue(
          yield* concat(
            yield* asRow(yield* resolveConstructor(expr.left, scope, assumptions, kind)),
            yield* asRow(yield* resolveConstructor(expr.right, scope, assumptions, kind)),
            assumptions,
          ),
        );
        break;
      }
      case "application": {
        result = yield* resolveConstructor(expr.fn, scope, assumptions);
        if (!expr.args.length)
          return yield* fail("Type application requires at least one argument");
        for (const arg of expr.args) {
          const kind = kindOf(result);
          if (kind.kind !== "arrow")
            return yield* fail(`Cannot apply ${show(result)} of kind ${showKind(kind)}`);
          result = yield* constructorApply(
            result,
            yield* resolveConstructor(arg, scope, assumptions, kind.param),
            assumptions,
          );
        }
        break;
      }
      case "map": {
        const mapper = yield* resolveConstructor(expr.fn, scope, assumptions);
        const kind = kindOf(mapper);
        if (kind.kind !== "arrow") return yield* fail("Map requires a type-level function");
        const source = yield* asRow(
          yield* resolveConstructor(expr.row, scope, assumptions, rowKind(kind.param)),
        );
        result = rowValue(yield* mapRow(mapper, source, assumptions));
        break;
      }
    }
    if (expected) yield* expectKind(kindOf(result), expected);
    return result;
  }).at(expr.span);

export const resolveRow = (
  expr: TypeExpr,
  scope: TypeScope,
  constraints: readonly Constraint[],
): Check<Row> => resolveConstructor(expr, scope, constraints, rowKind()).flatMap(asRow);

// Disjointness is about labels, even when the two rows carry different kinds.
// Bare row literals in constraints default to Row<Type>; named/mapped rows keep
// their declared element kind. Concat inherits its left row's kind.
export const resolveConstraintRow = (
  expr: TypeExpr,
  scope: TypeScope,
  constraints: readonly Constraint[],
): Check<Row> =>
  check(function* () {
    if (expr.kind === "concat")
      return yield* concat(
        yield* resolveConstraintRow(expr.left, scope, constraints),
        yield* resolveConstraintRow(expr.right, scope, constraints),
        constraints,
      );
    return yield* asRow(
      yield* resolveConstructor(
        expr,
        scope,
        constraints,
        expr.kind === "record" ? rowKind() : undefined,
      ),
    );
  }).at(expr.span);

export const resolve = (
  expr: TypeExpr,
  scope: TypeScope,
  constraints: readonly Constraint[],
): Check<Type> => resolveConstructor(expr, scope, constraints, typeKind);

export const bindGenerics = (
  generics: readonly Generic[],
  outer: TypeScope,
): Check<{ scope: TypeScope; parameters: readonly Parameter[] }> =>
  check(function* () {
    const scope = new Map(outer);
    const parameters: Parameter[] = [];
    for (const g of generics) {
      if (
        parameters.some((p) => p.name === g.name) ||
        ["number", "boolean", "string"].includes(g.name)
      )
        return yield* fail(`Duplicate or reserved type parameter: ${g.name}`).at(g.span);
      const parameter: Parameter = { id: Symbol(g.name), name: g.name, typeKind: g.kind };
      parameters.push(parameter);
      scope.set(g.name, variable(parameter));
    }
    return { scope, parameters };
  });

export const alias = (parameters: readonly Parameter[], body: Type): Type => {
  for (let i = parameters.length - 1; i >= 0; i--) body = abstraction(parameters[i]!, body);
  return body;
};

const polymorphic = (type: Type): boolean => {
  switch (type.kind) {
    case "function":
      return !!type.generics.length || type.params.some(polymorphic) || polymorphic(type.result);
    case "record":
    case "folder":
    case "row-value":
      return [...type.row.fields.values()].some(polymorphic);
    case "application":
      return polymorphic(type.fn) || polymorphic(type.arg);
    case "constructor-lambda":
      return polymorphic(type.body);
    default:
      return false;
  }
};

// Inference solves only bare quantified variables and one residual *unmapped*
// row. Never invert F<A> or Map<F,R>: F may discard A, so neither is injective.
const matchRow = (
  pattern: Row,
  actual: Row,
  bound: ReadonlySet<symbol>,
  sub: Map<symbol, Type>,
  assumptions: readonly Constraint[],
): Check<void> =>
  check(function* () {
    yield* expectKind(pattern.element, actual.element);
    const fields = new Map(actual.fields);
    for (const [name, type] of pattern.fields) {
      const found = fields.get(name);
      if (!found) return yield* fail(`Missing field: ${name}`);
      yield* match(type, found, bound, sub, assumptions);
      fields.delete(name);
    }
    const variables = [...actual.variables];
    const unknown: Parameter[] = [];
    for (const part of pattern.variables) {
      if (
        !part.mapper &&
        part.base.kind === "variable" &&
        bound.has(part.base.parameter.id) &&
        !sub.has(part.base.parameter.id)
      ) {
        unknown.push(part.base.parameter);
        continue;
      }
      const known = yield* substituteRow(
        row(new Map(), [part], pattern.element),
        sub,
        assumptions,
        new Set(),
      );
      for (const [name, type] of known.fields) {
        const found = fields.get(name);
        if (!found) return yield* fail(`Missing field: ${name}`);
        yield* match(type, found, bound, sub, assumptions);
        fields.delete(name);
      }
      for (const v of known.variables) {
        const index = variables.findIndex((w) => equalPart(v, w, new Map()));
        if (index < 0)
          return yield* fail(
            `Cannot match abstract row ${showRow(known)}; supply explicit type arguments`,
          );
        variables.splice(index, 1);
      }
    }
    if (unknown.length > 1)
      return yield* fail(
        "Ambiguous row decomposition; infer each row from a separate argument first",
      );
    if (unknown.length === 1)
      sub.set(unknown[0]!.id, rowValue(row(fields, variables, actual.element)));
    else if (fields.size || variables.length)
      return yield* fail("Record rows do not match (unexpected fields or row parameters)");
  });

const match = (
  input: Type,
  actual: Type,
  bound: ReadonlySet<symbol>,
  sub: Map<symbol, Type>,
  assumptions: readonly Constraint[],
): Check<void> =>
  check(function* () {
    const pattern =
      input.kind === "record" || input.kind === "folder" || input.kind === "function"
        ? input
        : yield* substitute(input, sub, assumptions, new Set());
    if (pattern.kind === "variable" && bound.has(pattern.parameter.id)) {
      const previous = sub.get(pattern.parameter.id);
      if (previous) yield* expect(actual, previous);
      else {
        yield* expectKind(kindOf(actual), pattern.parameter.typeKind);
        if (polymorphic(actual))
          return yield* fail(
            "Polymorphic values cannot be passed as generic arguments; use a monomorphic wrapper",
          );
        sub.set(pattern.parameter.id, actual);
      }
      return;
    }
    if (
      (pattern.kind === "record" && actual.kind === "record") ||
      (pattern.kind === "folder" && actual.kind === "folder")
    )
      return yield* matchRow(pattern.row, actual.row, bound, sub, assumptions);
    if (pattern.kind === "function" && actual.kind === "function") {
      if (pattern.generics.length) {
        // Do not solve outer inference variables from under a forall: doing so
        // could let a callback's bound type escape. All outer dependencies must
        // already be determined by explicit or earlier arguments.
        return yield* expect(actual, yield* substitute(pattern, sub, assumptions, bound));
      }
      if (
        actual.generics.length ||
        pattern.generics.length ||
        actual.params.length !== pattern.params.length
      )
        return yield* fail("Expected a monomorphic function with matching arity");
      for (let i = 0; i < pattern.params.length; i++)
        yield* match(pattern.params[i]!, actual.params[i]!, bound, sub, assumptions);
      yield* match(pattern.result, actual.result, bound, sub, assumptions);
      return;
    }
    yield* expect(actual, pattern);
  });

export const apply = (
  callee: FunctionType,
  args: readonly Type[],
  assumptions: readonly Constraint[],
  explicit?: readonly Type[],
): Check<Type> =>
  check(function* () {
    if (args.length !== callee.params.length)
      return yield* fail(`Expected ${callee.params.length} arguments, found ${args.length}`);
    if (explicit && explicit.length !== callee.generics.length)
      return yield* fail(
        `Expected ${callee.generics.length} type arguments, found ${explicit.length}`,
      );
    const bound = new Set(callee.generics.map((p) => p.id));
    const sub = new Map<symbol, Type>();
    for (let i = 0; i < (explicit?.length ?? 0); i++) {
      const parameter = callee.generics[i]!,
        value = explicit![i]!;
      yield* expectKind(kindOf(value), parameter.typeKind);
      if (polymorphic(value))
        return yield* fail("Polymorphic types cannot instantiate generic arguments");
      sub.set(parameter.id, value);
    }
    for (let i = 0; i < args.length; i++)
      yield* match(callee.params[i]!, args[i]!, bound, sub, assumptions);
    // Every binder must be determined, including phantom parameters: accepting a
    // missing argument would silently guess at a potentially noninjective type.
    for (const parameter of callee.generics)
      if (!sub.has(parameter.id))
        return yield* fail(
          `Cannot infer type parameter ${parameter.name}; supply explicit type arguments`,
        );
    for (const c of callee.constraints)
      yield* disjoint(
        yield* substituteRow(c.left, sub, assumptions, bound),
        yield* substituteRow(c.right, sub, assumptions, bound),
        assumptions,
      );
    for (let i = 0; i < args.length; i++)
      yield* expect(args[i]!, yield* substitute(callee.params[i]!, sub, assumptions, bound));
    return yield* substitute(callee.result, sub, assumptions, bound);
  });
