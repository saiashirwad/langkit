import { type Check, check, fail, pure } from "langkit";
import type { create } from "langkit/analysis";
import {
  type Base,
  type Binding,
  fieldValue,
  has,
  isScalar,
  type Model,
  type Relation,
  type Schema,
  showBase,
  showValue,
  unique,
  type Value,
} from "./schema-model.ts";
import type {
  Comparison,
  Declaration,
  Entry,
  Expr,
  Field,
  Name,
  Op,
  OrderKey,
  ParamType,
  Path,
  Pipeline,
  Stage,
} from "./schema-syntax.ts";

export type Term =
  | { readonly kind: "column"; readonly depth: number; readonly column: string; }
  | { readonly kind: "param"; readonly name: string; }
  | { readonly kind: "literal"; readonly value: string | number | boolean | null; }
  | { readonly kind: "now"; }
  | { readonly kind: "not"; readonly operand: Term; }
  | { readonly kind: "and" | "or"; readonly left: Term; readonly right: Term; }
  | {
    readonly kind: "compare";
    readonly op: Comparison;
    readonly left: Term;
    readonly right: Term;
    readonly nullSafe: boolean;
  }
  | { readonly kind: "isNull"; readonly operand: Term; readonly negated: boolean; }
  | { readonly kind: "follow"; readonly depth: number; readonly relation: Relation; readonly then: Term; }
  | { readonly kind: "read"; readonly read: Read; };

export type Output =
  | { readonly kind: "value"; readonly value: Value; }
  | { readonly kind: "object"; readonly shape: Shape; readonly nullable: boolean; }
  | { readonly kind: "list"; readonly shape: Shape; };

export type Column = { readonly key: Name; readonly term: Term; readonly output: Output; };

export type Shape =
  | { readonly kind: "model"; readonly model: Model; readonly columns: readonly Column[]; }
  | { readonly kind: "select"; readonly columns: readonly Column[]; };

export type Order = { readonly column: string; readonly descending: boolean; };

export type Result =
  | { readonly kind: "rows" | "first" | "single"; readonly shape: Shape; }
  | { readonly kind: "count" | "exists"; };

/** A pipeline over one table at nesting `depth`, correlated to its parent row through `link`. */
export type Read = {
  readonly kind: "read";
  readonly model: Model;
  readonly depth: number;
  readonly link: Relation | undefined;
  readonly where: readonly Term[];
  readonly order: readonly Order[];
  readonly offset: Term | undefined;
  readonly limit: Term | undefined;
  readonly result: Result;
};

export type Assignment = { readonly column: string; readonly term: Term; };

export type Write =
  & { readonly model: Model; readonly returning: Shape | undefined; }
  & (
    | { readonly kind: "insert"; readonly values: readonly Assignment[]; }
    | { readonly kind: "update"; readonly where: readonly Term[]; readonly values: readonly Assignment[]; }
    | { readonly kind: "delete"; readonly where: readonly Term[]; }
  );

export type Statement = Read | Write;

export type Param = { readonly name: Name; readonly value: Value; };

export type Query = { readonly name: Name; readonly params: readonly Param[]; readonly statement: Statement; };

export type HelperKind = "model" | "query";

type Helper = Extract<Declaration, { kind: "helper"; }>;

export type Scope = {
  readonly facts: ReturnType<typeof create<string>>;
  readonly models: ReadonlyMap<string, Model>;
  readonly relations: Schema["relations"];
  readonly enums: ReadonlyMap<string, Extract<Declaration, { kind: "enum"; }>>;
  readonly helpers: ReadonlyMap<string, Helper>;
  readonly kinds: ReadonlyMap<string, HelperKind>;
  readonly declared: (name: string) => Binding;
  readonly field: (model: Model, name: string) => Binding;
  readonly member: (member: Name) => Binding;
};

export const output = (read: Read): Output => {
  switch (read.result.kind) {
    case "rows":
      return { kind: "list", shape: read.result.shape };
    case "first":
      return { kind: "object", shape: read.result.shape, nullable: true };
    case "single":
      return { kind: "object", shape: read.result.shape, nullable: read.link?.arity === "optional" };
    case "count":
      return { kind: "value", value: { base: { kind: "scalar", name: "Int" }, nullable: false } };
    case "exists":
      return { kind: "value", value: bool };
  }
};

const bool: Value = { base: { kind: "scalar", name: "Bool" }, nullable: false };

const filters: ReadonlySet<Op["kind"]> = new Set(["where", "orderBy", "offset", "limit"]);

const stages: ReadonlySet<Op["kind"]> = new Set([
  ...filters,
  "select",
  "returning",
  "insert",
  "update",
  "first",
  "count",
  "exists",
  "delete",
]);

export const isStage = (op: Op): op is Stage => stages.has(op.kind);

export const isFilter = (op: Op): op is Extract<Stage, { kind: "where" | "orderBy" | "offset" | "limit"; }> =>
  filters.has(op.kind);

const rank: Readonly<Record<string, number>> = {
  where: 0,
  orderBy: 0,
  offset: 1,
  limit: 2,
  select: 3,
  first: 4,
  count: 4,
  exists: 4,
};

const writes: ReadonlySet<Op["kind"]> = new Set(["insert", "update", "delete"]);

type Located = { readonly stage: Stage; readonly labels: readonly string[]; };

type Row = { readonly model: Model; readonly depth: number; };

type Typed = {
  readonly term: Term;
  readonly type: Output | { readonly kind: "null"; };
  readonly expr: Expr;
  readonly label: string | undefined;
};

const error = (name: { readonly span: Name["span"]; }, message: string): Check<never> => fail(message).at(name.span);

const within = <A>(labels: readonly string[], body: Check<A>): Check<A> =>
  labels.reduceRight((inner, label) => inner.context(label), body);

const orderable = (base: Base): boolean => base.kind === "key" || (base.kind === "scalar" && base.name !== "Bool");

const sameBase = (left: Base, right: Base): boolean => left.kind === right.kind && showBase(left) === showBase(right);

const showOutput = (type: Typed["type"]): string =>
  type.kind === "value" ? showValue(type.value) : type.kind === "null" ? "null" : "a nested row";

export const checkQueries = (scope: Scope, declarations: readonly Declaration[]): Check<readonly Query[]> =>
  check(function*() {
    const queries: Query[] = [];
    for (const declaration of declarations) {
      if (declaration.kind !== "query") continue;
      const query = yield* checkQuery(scope, declaration).context(`query ${declaration.name.name}`).recover(
        pure(undefined),
      );
      if (query) queries.push(query);
    }
    return queries;
  });

const checkQuery = (scope: Scope, declaration: Extract<Declaration, { kind: "query"; }>): Check<Query> =>
  check(function*() {
    const { facts, models, relations } = scope;
    const params = new Map<string, { readonly param: Param; readonly binding: Binding; }>();
    const used = new Set<string>();

    const reference = (target: Binding, name: Name): Check<void> =>
      check(function*() {
        yield* facts.reference(target, name.span);
        yield* facts.typed(target.type, name.span);
      });

    const relationBinding = (relation: Relation): Binding => ({
      id: relation.id,
      name: relation.name.name,
      type: relation.arity === "many"
        ? `${relation.target}[]`
        : `${relation.target}${relation.arity === "optional" ? "?" : ""}`,
    });

    const valueOf = (model: Model, field: Field): Value =>
      fieldValue(models, model, field) ?? {
        base: isScalar(field.type.name)
          ? { kind: "scalar", name: field.type.name }
          : { kind: "enum", name: field.type.name },
        nullable: field.optional,
      };

    const fieldOf = (model: Model, name: Name): Check<Field> =>
      check(function*() {
        const field = model.fields.find((candidate) => candidate.name.name === name.name);
        if (!field) return yield* error(name, `Unknown field: ${model.name.name}.${name.name}`);
        yield* reference(scope.field(model, name.name), name);
        return field;
      });

    const paramValue = (type: ParamType): Check<Value> =>
      check(function*() {
        if (type.kind === "field") {
          const model = models.get(type.model.name);
          if (!model) return yield* error(type.model, `Unknown model: ${type.model.name}`);
          yield* reference(scope.declared(type.model.name), type.model);
          const value = valueOf(model, yield* fieldOf(model, type.field));
          return { ...value, nullable: value.nullable || type.optional };
        }
        if (isScalar(type.name.name)) {
          yield* facts.typed(type.name.name, type.name.span);
          return { base: { kind: "scalar", name: type.name.name }, nullable: type.optional };
        }
        if (!scope.enums.has(type.name.name)) return yield* error(type.name, `Unknown type: ${type.name.name}`);
        yield* reference(scope.declared(type.name.name), type.name);
        return { base: { kind: "enum", name: type.name.name }, nullable: type.optional };
      });

    for (const { name, type } of declaration.params) {
      if (params.has(name.name)) return yield* error(name, `Duplicate parameter: ${name.name}`);
      const value = yield* paramValue(type);
      const binding: Binding = { id: Symbol(name.name), name: name.name, type: showValue(value) };
      yield* facts.define(binding, name.span, "parameter");
      params.set(name.name, { param: { name, value }, binding });
    }

    const expand = (ops: readonly Op[], labels: readonly string[]): Check<readonly Located[]> =>
      check(function*() {
        const located: Located[] = [];
        for (const op of ops) {
          if (op.kind === "helper") {
            const helper = scope.helpers.get(op.name.name);
            if (!helper) return yield* within(labels, error(op.name, `Unknown query helper: ${op.name.name}`));
            yield* reference(scope.declared(op.name.name), op.name);
            if (scope.kinds.get(op.name.name) !== "query") {
              return yield* within(
                labels,
                error(op.name, `${op.name.name} is a model helper; it cannot apply to a query`),
              );
            }
            located.push(...(yield* expand(helper.body.ops, [...labels, `applying ${op.name.name}`])));
          } else if (isStage(op)) located.push({ stage: op, labels });
          else {
            return yield* within(labels, error(op.name, `${op.kind} is a model operation; it cannot apply to a query`));
          }
        }
        return located;
      });

    const path = (segments: Path["segments"], row: Row, expr: Expr): Check<Typed> =>
      check(function*() {
        const hops: { readonly depth: number; readonly relation: Relation; }[] = [];
        let current = row;
        let nullable = false;
        for (const [index, segment] of segments.entries()) {
          const owner = current.model.name.name;
          const field = current.model.fields.find((candidate) => candidate.name.name === segment.name);
          const last = index === segments.length - 1;
          if (field) {
            if (!last) {
              return yield* error(
                segment,
                `${owner}.${segment.name} is a field, not a relation; only relations can be followed`,
              );
            }
            yield* reference(scope.field(current.model, segment.name), segment);
            const value = valueOf(current.model, field);
            const term = hops.reduceRight<Term>(
              (then, hop) => ({ kind: "follow", depth: hop.depth, relation: hop.relation, then }),
              { kind: "column", depth: current.depth, column: segment.name },
            );
            return {
              term,
              type: { kind: "value", value: { ...value, nullable: value.nullable || nullable } },
              expr,
              label: `${owner}.${segment.name}`,
            };
          }
          const relation = relations.get(owner)?.get(segment.name);
          if (!relation) return yield* error(segment, `Unknown field: ${owner}.${segment.name}`);
          yield* reference(relationBinding(relation), segment);
          if (last) {
            return yield* error(
              segment,
              `${owner}.${segment.name} is a relation; select from it with .${segment.name} |> select { ... }`,
            );
          }
          if (relation.arity === "many") {
            return yield* error(
              segment,
              `${owner}.${segment.name} is a list of ${relation.target}; use .${segment.name} |> count, exists, first or select`,
            );
          }
          nullable ||= relation.arity === "optional";
          hops.push({ depth: current.depth, relation });
          current = { model: models.get(relation.target)!, depth: current.depth + 1 };
        }
        throw new Error("unreachable: paths have at least one segment");
      });

    const boolean = (typed: Typed, what: string): Check<Term> =>
      typed.type.kind === "value" && typed.type.value.base.kind === "scalar" && typed.type.value.base.name === "Bool"
        ? check(function*() {
          return typed.term;
        })
        : error(typed.expr, `${what} needs Bool, got ${showOutput(typed.type)}`);

    const keyFromLiteral = (key: Base, other: Typed): Check<void> =>
      check(function*() {
        if (key.kind !== "key" || other.expr.kind !== "literal") return;
        const model = models.get(key.model)!;
        const primary = model.fields.find((field) => has(field, "primaryKey"))!;
        return yield* error(
          other.expr,
          `A ${showBase(key)} comes from a ${model.name.name}.${primary.name.name} parameter, not a literal`,
        );
      });

    const adapts = (target: Base, source: Typed): boolean =>
      target.kind === "scalar" && target.name === "Float" && source.expr.kind === "literal"
      && typeof source.expr.value === "number";

    const compare = (expr: Extract<Expr, { kind: "compare"; }>, row: Row | undefined): Check<Typed> =>
      check(function*() {
        const left = yield* typed(expr.left, row);
        const right = yield* typed(expr.right, row);
        const result = (term: Term): Typed => ({ term, type: { kind: "value", value: bool }, expr, label: undefined });
        if (left.type.kind === "null" || right.type.kind === "null") {
          const [value, empty] = left.type.kind === "null" ? [right, left] : [left, right];
          if (value.type.kind === "null") return yield* error(expr, "Compare a value with null, not null with null");
          if (expr.op !== "==" && expr.op !== "!=") return yield* error(empty.expr, `Only == and != compare with null`);
          if (value.type.kind !== "value" || !value.type.value.nullable) {
            return yield* error(expr, `${value.label ?? "This value"} is never null`);
          }
          return result({ kind: "isNull", operand: value.term, negated: expr.op === "!=" });
        }
        if (left.type.kind !== "value" || right.type.kind !== "value") {
          return yield* error(expr, "Cannot compare a nested row");
        }
        const [l, r] = [left.type.value, right.type.value];
        yield* keyFromLiteral(l.base, right);
        yield* keyFromLiteral(r.base, left);
        if (!sameBase(l.base, r.base) && !adapts(l.base, right) && !adapts(r.base, left)) {
          return yield* error(expr, `Cannot compare ${showBase(l.base)} with ${showBase(r.base)}`);
        }
        if (expr.op !== "==" && expr.op !== "!=" && !orderable(l.base)) {
          return yield* error(expr, `Cannot order ${showBase(l.base)} values`);
        }
        return result({
          kind: "compare",
          op: expr.op,
          left: left.term,
          right: right.term,
          nullSafe: l.nullable || r.nullable,
        });
      });

    const typed = (expr: Expr, row: Row | undefined): Check<Typed> =>
      check(function*(): Generator<Check<unknown>, Typed, never> {
        const value = (term: Term, value: Value, label?: string): Typed => ({
          term,
          type: { kind: "value", value },
          expr,
          label,
        });
        switch (expr.kind) {
          case "path":
            if (!row) return yield* error(expr, "An insert has no current row; use a parameter");
            return yield* path(expr.path.segments, row, expr);
          case "name": {
            const found = params.get(expr.name.name);
            if (!found) return yield* error(expr, `Unknown parameter: ${expr.name.name}`);
            used.add(expr.name.name);
            yield* reference(found.binding, expr.name);
            return value({ kind: "param", name: expr.name.name }, found.param.value, expr.name.name);
          }
          case "member": {
            const enumeration = scope.enums.get(expr.type.name);
            if (!enumeration) return yield* error(expr.type, `Unknown enum: ${expr.type.name}`);
            const member = enumeration.members.find((candidate) => candidate.name === expr.member.name);
            if (!member) return yield* error(expr.member, `Unknown enum value: ${expr.type.name}.${expr.member.name}`);
            yield* reference(scope.declared(expr.type.name), expr.type);
            yield* reference(scope.member(member), expr.member);
            return value({ kind: "literal", value: member.name }, {
              base: { kind: "enum", name: enumeration.name.name },
              nullable: false,
            });
          }
          case "literal": {
            const name = typeof expr.value === "string"
              ? "String"
              : typeof expr.value === "boolean"
              ? "Bool"
              : Number.isInteger(expr.value)
              ? "Int"
              : "Float";
            return value({ kind: "literal", value: expr.value }, { base: { kind: "scalar", name }, nullable: false });
          }
          case "null":
            return { term: { kind: "literal", value: null }, type: { kind: "null" }, expr, label: undefined };
          case "now":
            return value({ kind: "now" }, { base: { kind: "scalar", name: "DateTime" }, nullable: false });
          case "not": {
            const operand = yield* boolean(yield* typed(expr.operand, row), "not");
            return value({ kind: "not", operand }, bool);
          }
          case "and":
          case "or": {
            const left = yield* boolean(yield* typed(expr.left, row), expr.kind);
            const right = yield* boolean(yield* typed(expr.right, row), expr.kind);
            return value({ kind: expr.kind, left, right }, bool);
          }
          case "compare":
            return yield* compare(expr, row);
          case "pipeline": {
            if (!row) return yield* error(expr, "An insert has no current row to follow");
            const read = yield* nested(expr.pipeline, row);
            return { term: { kind: "read", read }, type: output(read), expr, label: undefined };
          }
        }
      });

    const shape = (entries: readonly Entry[], row: Row): Check<Shape> =>
      check(function*() {
        const columns: Column[] = [];
        for (const entry of entries) {
          if (columns.some((column) => column.key.name === entry.key.name)) {
            return yield* error(entry.key, `Duplicate key: ${entry.key.name}`);
          }
          const value = yield* typed(entry.value, row);
          if (value.type.kind === "null") return yield* error(entry.value, "A selected value cannot be null");
          yield* facts.define(
            { id: Symbol(entry.key.name), name: entry.key.name, type: showOutput(value.type) },
            entry.key.span,
            "property",
          );
          columns.push({ key: entry.key, term: value.term, output: value.type });
        }
        return { kind: "select", columns };
      });

    const modelShape = ({ model, depth }: Row): Shape => ({
      kind: "model",
      model,
      columns: model.fields.map((field) => ({
        key: field.name,
        term: { kind: "column", depth, column: field.name.name },
        output: { kind: "value", value: valueOf(model, field) },
      })),
    });

    const page = (stage: Extract<Stage, { kind: "offset" | "limit"; }>, row: Row): Check<Term> =>
      check(function*() {
        const count = yield* typed(stage.count, row);
        const int = count.type.kind === "value" && count.type.value.base.kind === "scalar"
          && count.type.value.base.name === "Int" && !count.type.value.nullable;
        if (!int) return yield* error(stage.count, `${stage.kind} needs Int, got ${showOutput(count.type)}`);
        if (stage.count.kind === "literal" && Number(stage.count.value) < 0) {
          return yield* error(stage.count, `${stage.kind} cannot be negative`);
        }
        if (stage.count.kind !== "name" && stage.count.kind !== "literal") {
          return yield* error(stage.count, `${stage.kind} takes a parameter or a literal`);
        }
        return count.term;
      });

    const orderBy = (keys: readonly OrderKey[], model: Model): Check<readonly Order[]> =>
      check(function*() {
        const order: Order[] = [];
        for (const key of keys) {
          yield* fieldOf(model, key.field);
          order.push({ column: key.field.name, descending: key.descending });
        }
        return order;
      });

    const determined = (where: readonly Term[], { model, depth }: Row): boolean => {
      const matched = new Set(
        where.flatMap((term) => {
          if (term.kind !== "compare" || term.op !== "==") return [];
          const own = (side: Term) => side.kind === "column" && side.depth === depth;
          if (own(term.left) && !own(term.right) && term.left.kind === "column") return [term.left.column];
          if (own(term.right) && !own(term.left) && term.right.kind === "column") return [term.right.column];
          return [];
        }),
      );
      return model.fields.some((field) => unique(model, field) && matched.has(field.name.name))
        || model.constraints.some((c) => c.kind === "unique" && c.fields.every((field) => matched.has(field.name)));
    };

    const conjuncts = (term: Term): readonly Term[] =>
      term.kind === "and" ? [...conjuncts(term.left), ...conjuncts(term.right)] : [term];

    const read = (row: Row, link: Relation | undefined, located: readonly Located[]): Check<Read> =>
      check(function*() {
        const where: Term[] = [];
        let order: readonly Order[] | undefined;
        let offset: Term | undefined;
        let limit: Term | undefined;
        let selected: Shape | undefined;
        let terminal: "first" | "count" | "exists" | undefined;
        let previous: Stage | undefined;
        for (const { stage, labels } of located) {
          yield* within(
            labels,
            check(function*() {
              const name = stage.name;
              if (link && link.arity !== "many" && stage.kind !== "select") {
                return yield* error(
                  name,
                  `${stage.kind} cannot apply to ${link.name.name}, which is one ${link.target}; only select applies`,
                );
              }
              const position = rank[stage.kind];
              if (position === undefined) {
                return yield* error(
                  name,
                  stage.kind === "returning"
                    ? "returning follows insert, update or delete"
                    : `${stage.kind} cannot appear in a nested pipeline`,
                );
              }
              const before = previous && rank[previous.kind]!;
              if (previous && before !== undefined && (position < before || (position === before && position > 0))) {
                return yield* error(name, `${stage.kind} cannot follow ${previous.kind}`);
              }
              switch (stage.kind) {
                case "where":
                  where.push(...conjuncts(yield* boolean(yield* typed(stage.condition, row), "where")));
                  break;
                case "orderBy":
                  if (order) return yield* error(name, "Duplicate orderBy");
                  order = yield* orderBy(stage.keys, row.model);
                  break;
                case "offset":
                  offset = yield* page(stage, row);
                  break;
                case "limit":
                  limit = yield* page(stage, row);
                  break;
                case "select":
                  selected = yield* shape(stage.entries, row);
                  break;
                case "first":
                  if (limit) return yield* error(name, "first takes one row; remove limit");
                  if (!order && !determined(where, row)) {
                    return yield* error(
                      name,
                      `first picks an arbitrary ${row.model.name.name}; add orderBy or match a unique field`,
                    );
                  }
                  terminal = "first";
                  break;
                case "count":
                case "exists":
                  if (selected) return yield* error(name, `${stage.kind} cannot follow select`);
                  terminal = stage.kind;
                  break;
              }
              previous = stage;
            }),
          );
        }
        const projection = selected ?? modelShape(row);
        const result: Result = terminal === "count" || terminal === "exists"
          ? { kind: terminal }
          : terminal === "first"
          ? { kind: "first", shape: projection }
          : { kind: link && link.arity !== "many" ? "single" : "rows", shape: projection };
        return {
          kind: "read",
          model: row.model,
          depth: row.depth,
          link,
          where,
          order: order ?? [],
          offset,
          limit,
          result,
        };
      });

    const nested = (pipeline: Pipeline, row: Row): Check<Read> =>
      check(function*() {
        const source = pipeline.source;
        if (source.kind !== "relation") throw new Error("unreachable: nested pipelines start at a relation");
        if (source.path.segments.length !== 1) {
          return yield* error(source.path, "A nested pipeline starts at one relation, like .posts");
        }
        const segment = source.path.segments[0];
        const owner = row.model.name.name;
        const relation = relations.get(owner)?.get(segment.name);
        if (!relation) {
          return yield* error(
            segment,
            row.model.fields.some((field) => field.name.name === segment.name)
              ? `${owner}.${segment.name} is a field, not a relation`
              : `Unknown relation: ${owner}.${segment.name}`,
          );
        }
        yield* reference(relationBinding(relation), segment);
        const target = { model: models.get(relation.target)!, depth: row.depth + 1 };
        return yield* read(target, relation, yield* expand(pipeline.ops, []));
      });

    const assignments = (
      model: Model,
      entries: readonly Entry[],
      row: Row | undefined,
      write: Name,
    ): Check<readonly Assignment[]> =>
      check(function*() {
        const values: Assignment[] = [];
        for (const entry of entries) {
          const field = yield* fieldOf(model, entry.key);
          const label = `${model.name.name}.${field.name.name}`;
          if (values.some((value) => value.column === field.name.name)) {
            return yield* error(entry.key, `Duplicate key: ${entry.key.name}`);
          }
          if (has(field, "autoIncrement")) return yield* error(entry.key, `${label} is autoIncrement`);
          if (write.name === "update" && has(field, "primaryKey")) {
            return yield* error(entry.key, `${label} is a primary key`);
          }
          if (entry.value.kind === "pipeline" || (entry.value.kind === "path" && !row)) {
            return yield* error(entry.value, `${write.name} values come from parameters, literals and enum members`);
          }
          const value = yield* typed(entry.value, row);
          const target = valueOf(model, field);
          if (value.type.kind === "null") {
            if (!target.nullable) return yield* error(entry.value, `${label} is never null`);
          } else {
            yield* keyFromLiteral(target.base, value);
            const source = value.type.kind === "value" ? value.type.value : undefined;
            const fits = source && (sameBase(target.base, source.base) || adapts(target.base, value))
              && (target.nullable || !source.nullable);
            if (!fits) {
              return yield* error(entry.value, `${label} needs ${showValue(target)}, got ${showOutput(value.type)}`);
            }
          }
          values.push({ column: field.name.name, term: value.term });
        }
        return values;
      });

    const write = (model: Model, located: readonly Located[], at: number): Check<Write> =>
      check(function*() {
        const { stage } = located[at]!;
        const row: Row = { model, depth: 0 };
        const where: Term[] = [];
        for (const { stage: before, labels } of located.slice(0, at)) {
          if (stage.kind === "insert" || before.kind !== "where") {
            return yield* within(labels, error(before.name, `${before.kind} cannot come before ${stage.kind}`));
          }
          where.push(...conjuncts(yield* within(labels, boolean(yield* typed(before.condition, row), "where"))));
        }
        let returning: Shape | undefined;
        for (const { stage: after, labels } of located.slice(at + 1)) {
          if (after.kind !== "returning" || returning) {
            return yield* within(labels, error(after.name, `${after.kind} cannot follow ${stage.kind}`));
          }
          returning = yield* shape(after.entries, row);
        }
        const table = model.name.name;
        switch (stage.kind) {
          case "insert": {
            const values = yield* assignments(model, stage.entries, undefined, stage.name);
            const missing = model.fields.filter((field) =>
              !field.optional && !has(field, "default") && !has(field, "autoIncrement")
              && !values.some((value) => value.column === field.name.name)
            );
            if (missing.length) {
              return yield* error(
                stage.name,
                `insert ${table} is missing ${missing.map((field) => field.name.name).join(", ")}`,
              );
            }
            return { kind: "insert", model, values, returning };
          }
          case "update": {
            if (!where.length) {
              return yield* error(stage.name, `update without where changes every ${table}; write where true`);
            }
            if (!stage.entries.length) return yield* error(stage.name, "update needs at least one field");
            const values = yield* assignments(model, stage.entries, row, stage.name);
            return { kind: "update", model, where, values, returning };
          }
          case "delete":
            if (!where.length) {
              return yield* error(stage.name, `delete without where removes every ${table}; write where true`);
            }
            return { kind: "delete", model, where, returning };
          default:
            throw new Error(`unreachable: ${stage.kind} is not a write`);
        }
      });

    const source = declaration.body.source;
    if (source.kind !== "model") throw new Error("unreachable: queries start at a model");
    const model = models.get(source.name.name);
    if (!model) return yield* error(source.name, `Unknown model: ${source.name.name}`);
    yield* reference(scope.declared(source.name.name), source.name);
    const located = yield* expand(declaration.body.ops, []);
    const at = located.findIndex(({ stage }) => writes.has(stage.kind));
    const statement: Statement = at >= 0
      ? yield* write(model, located, at)
      : yield* read({ model, depth: 0 }, undefined, located);
    for (const { param } of params.values()) {
      if (!used.has(param.name.name)) yield* error(param.name, `Unused parameter: ${param.name.name}`).recover();
    }
    return { name: declaration.name, params: [...params.values()].map(({ param }) => param), statement };
  });
