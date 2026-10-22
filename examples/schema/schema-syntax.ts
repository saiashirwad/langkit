import type { Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import { parseResult } from "langkit/parse";
import {
  between,
  choice,
  commit,
  createLexemes,
  fail,
  lookahead,
  many,
  many1,
  named,
  optional,
  type Parser,
  parser,
  regex,
  sepBy1,
  sepEndBy,
} from "langkit/parse";

export type Name = { readonly name: string; readonly span: Span; };

export type Default =
  | { readonly kind: "literal"; readonly value: string | number | boolean; }
  | { readonly kind: "now"; }
  | { readonly kind: "enum"; readonly type: Name; readonly member: Name; };

export type FieldOp =
  & { readonly name: Name; }
  & (
    | { readonly kind: "primaryKey" | "autoIncrement" | "unique"; }
    | { readonly kind: "default"; readonly value: Default; }
    | {
      readonly kind: "references";
      readonly model: Name;
      readonly field: Name;
      readonly relation: Name | undefined;
    }
  );

export type Field = {
  readonly name: Name;
  readonly type: Name;
  readonly optional: boolean;
  readonly ops: readonly FieldOp[];
};

export type ModelOp =
  & { readonly name: Name; }
  & (
    | { readonly kind: "extend"; readonly fields: readonly Field[]; }
    | { readonly kind: "index" | "unique"; readonly fields: readonly Name[]; }
    | { readonly kind: "many" | "one"; readonly relation: Name; readonly model: Name; readonly inverse: Name; }
    | { readonly kind: "helper"; }
  );

export type Path = { readonly segments: readonly [Name, ...Name[]]; readonly span: Span; };

export type Comparison = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr =
  & { readonly span: Span; }
  & (
    | { readonly kind: "path"; readonly path: Path; }
    | { readonly kind: "name"; readonly name: Name; }
    | { readonly kind: "member"; readonly type: Name; readonly member: Name; }
    | { readonly kind: "literal"; readonly value: string | number | boolean; }
    | { readonly kind: "null" | "now"; }
    | { readonly kind: "not"; readonly operand: Expr; }
    | { readonly kind: "and" | "or"; readonly left: Expr; readonly right: Expr; }
    | { readonly kind: "compare"; readonly op: Comparison; readonly left: Expr; readonly right: Expr; }
    | { readonly kind: "pipeline"; readonly relation: Path; readonly ops: readonly Op[]; }
  );

export type Entry = { readonly key: Name; readonly value: Expr; };

export type OrderKey = { readonly field: Name; readonly descending: boolean; };

export type Stage =
  & { readonly name: Name; }
  & (
    | { readonly kind: "where"; readonly condition: Expr; }
    | { readonly kind: "orderBy"; readonly keys: readonly OrderKey[]; }
    | { readonly kind: "offset" | "limit"; readonly count: Expr; }
    | { readonly kind: "select" | "returning"; readonly entries: readonly Entry[]; }
    | { readonly kind: "insert" | "update"; readonly entries: readonly Entry[]; }
    | { readonly kind: "first" | "count" | "exists"; }
    | { readonly kind: "delete"; }
  );

/** Model operations and query stages share one pipe; the checker decides which a context accepts. */
export type Op = ModelOp | Stage;

export type Pipeline = { readonly model: Name; readonly ops: readonly Op[]; };

export type ParamType =
  | { readonly kind: "named"; readonly name: Name; readonly optional: boolean; }
  | { readonly kind: "field"; readonly model: Name; readonly field: Name; readonly optional: boolean; };

export type Param = { readonly name: Name; readonly type: ParamType; };

export type ModelExpr = {
  readonly base:
    | { readonly kind: "fields"; readonly fields: readonly Field[]; }
    | { readonly kind: "name"; readonly name: Name; };
  readonly ops: readonly Op[];
};

export type Declaration =
  & { readonly name: Name; }
  & (
    | { readonly kind: "enum"; readonly members: readonly Name[]; }
    | { readonly kind: "model"; readonly body: ModelExpr; }
    | { readonly kind: "helper"; readonly param: Name; readonly body: ModelExpr; }
    | { readonly kind: "query"; readonly params: readonly Param[]; readonly body: Pipeline; }
  );

const words = /[a-zA-Z_][a-zA-Z_0-9]*/;
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const digits = /-?\d+(?:\.\d+)?/;
const keywords = [
  "model",
  "type",
  "let",
  "fn",
  "true",
  "false",
  "as",
  "query",
  "null",
  "and",
  "or",
  "not",
] as const;

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*)*/),
  identifier: words,
  keywords,
});

const { keyword, symbol } = lex;

const name = named(lex.identifier);
// `model` is also the natural parameter name in a model helper.
const parameter = named(choice(lex.identifier, keyword("model")));

const defaultValue: Parser<Default> = choice(
  lex
    .token(regex(strings))
    .map((text) => ({ kind: "literal" as const, value: JSON.parse(text) as string })),
  lex.token(regex(digits)).map((text) => ({ kind: "literal" as const, value: Number(text) })),
  keyword("true").map(() => ({ kind: "literal" as const, value: true })),
  keyword("false").map(() => ({ kind: "literal" as const, value: false })),
  parser(function*() {
    const type = yield* name;
    if (type.name === "now") return { kind: "now" as const };
    yield* symbol(".");
    return { kind: "enum" as const, type, member: yield* name };
  }),
);

const fieldOp: Parser<FieldOp> = parser(function*() {
  yield* symbol("|>");
  yield* commit();
  const op = yield* name;
  switch (op.name) {
    case "primaryKey":
    case "autoIncrement":
    case "unique":
      return { kind: op.name, name: op };
    case "default":
      return { kind: "default", name: op, value: yield* defaultValue };
    case "references": {
      const model = yield* name;
      yield* symbol(".");
      const field = yield* name;
      const relation = yield* optional(keyword("as").zipRight(name));
      return { kind: "references", name: op, model, field, relation };
    }
    default:
      return yield* fail(`Unknown field operation: ${op.name}`);
  }
});

const field: Parser<Field> = parser(function*() {
  const fieldName = yield* name;
  yield* symbol(":");
  yield* commit();
  const type = yield* name;
  const nullable = yield* optional(symbol("?"));
  return { name: fieldName, type, optional: nullable !== undefined, ops: yield* many(fieldOp) };
});
const fields = between(symbol("{"), symbol("}"), sepEndBy(field, symbol(",")));
const selector = symbol(".").zipRight(name);

const spanOf = (from: { readonly span: Span; }, to: { readonly span: Span; }): Span => ({
  start: from.span.start,
  end: to.span.end,
});

const exact = <T>(p: Parser<string>, value: (text: string) => T): Parser<{ readonly value: T; readonly span: Span; }> =>
  lex.token(
    p.withSpan((text, span) => ({ value: value(text), span: { start: span.start, end: span.start + text.length } })),
  );

const literal = ({ value, span }: { readonly value: string | number | boolean; readonly span: Span; }): Expr => ({
  kind: "literal",
  value,
  span,
});

const path: Parser<Path> = many1(selector).withSpan((segments, span): Path => {
  const [first, ...rest] = segments;
  return { segments: [first!, ...rest], span: { start: span.start, end: segments.at(-1)!.span.end } };
});

const comparison: Parser<Comparison> = choice(
  symbol("=="),
  symbol("!="),
  symbol("<="),
  symbol(">="),
  symbol("<"),
  symbol(">"),
);

const atom: Parser<Expr> = parser(function*(): Generator<Parser<unknown>, Expr, never> {
  return yield* choice(
    parser(function*() {
      const open = yield* exact(symbol("("), () => undefined);
      const inner = yield* nested;
      const close = yield* exact(symbol(")"), () => undefined);
      return { ...inner, span: spanOf(open, close) };
    }),
    path.map((path): Expr => ({ kind: "path", path, span: path.span })),
    exact(regex(strings), (text) => JSON.parse(text) as string).map(literal),
    exact(regex(digits), Number).map(literal),
    exact(keyword("true"), () => true).map(literal),
    exact(keyword("false"), () => false).map(literal),
    exact(keyword("null"), () => null).map(({ span }): Expr => ({ kind: "null", span })),
    parser(function*() {
      const first = yield* name;
      const member = yield* optional(selector);
      if (member) return { kind: "member" as const, type: first, member, span: spanOf(first, member) };
      return first.name === "now"
        ? { kind: "now" as const, span: first.span }
        : { kind: "name" as const, name: first, span: first.span };
    }),
  );
});

const compared: Parser<Expr> = parser(function*() {
  const left = yield* atom;
  const op = yield* optional(comparison);
  if (op === undefined) return left;
  const right = yield* atom;
  return { kind: "compare" as const, op, left, right, span: spanOf(left, right) };
});

const negated: Parser<Expr> = parser(function*(): Generator<Parser<unknown>, Expr, never> {
  const not = yield* optional(exact(keyword("not"), () => undefined));
  if (!not) return yield* compared;
  const operand = yield* negated;
  return { kind: "not", operand, span: spanOf(not, operand) };
});

const logical = (kind: "and" | "or", operand: Parser<Expr>): Parser<Expr> =>
  parser(function*() {
    let left = yield* operand;
    while (yield* optional(keyword(kind))) {
      const right = yield* operand;
      left = { kind, left, right, span: spanOf(left, right) };
    }
    return left;
  });

export const expression: Parser<Expr> = logical("or", logical("and", negated));

const nested: Parser<Expr> = parser(function*() {
  const value = yield* expression;
  const ops = yield* many(op);
  if (!ops.length) return value;
  if (value.kind !== "path") return yield* fail("A nested pipeline starts at a relation, like .posts");
  const last = ops.at(-1)!;
  return {
    kind: "pipeline" as const,
    relation: value.path,
    ops,
    span: { start: value.span.start, end: last.name.span.end },
  };
});

const entry: Parser<Entry> = choice(
  parser(function*() {
    yield* lookahead(symbol("."));
    const value = yield* nested;
    if (value.kind === "path") return { key: value.path.segments.at(-1)!, value };
    if (value.kind === "pipeline") return { key: value.relation.segments.at(-1)!, value };
    return yield* fail("A record entry needs a key, like name: value");
  }),
  parser(function*() {
    const key = yield* name;
    const keyed = yield* optional(symbol(":"));
    if (keyed === undefined) return { key, value: { kind: "name" as const, name: key, span: key.span } };
    yield* commit();
    return { key, value: yield* nested };
  }),
);

const record = between(symbol("{"), symbol("}"), sepEndBy(entry, symbol(",")));

const orderKey: Parser<OrderKey> = parser(function*() {
  const field = yield* selector;
  const direction = yield* optional(name);
  if (direction && direction.name !== "asc" && direction.name !== "desc") {
    return yield* fail(`Expected asc or desc, found ${direction.name}`);
  }
  return { field, descending: direction?.name === "desc" };
});

const op: Parser<Op> = parser(function*() {
  yield* symbol("|>");
  yield* commit();
  const op = yield* name;
  switch (op.name) {
    case "extend":
      return { kind: "extend", name: op, fields: yield* fields };
    case "index":
    case "unique":
      return {
        kind: op.name,
        name: op,
        fields: yield* between(symbol("["), symbol("]"), sepBy1(selector, symbol(","))),
      };
    case "many":
    case "one": {
      const relation = yield* name;
      yield* symbol("=");
      const model = yield* name;
      yield* symbol(".");
      return { kind: op.name, name: op, relation, model, inverse: yield* name };
    }
    case "where":
      return { kind: "where", name: op, condition: yield* expression };
    case "orderBy":
      return {
        kind: "orderBy",
        name: op,
        keys: yield* between(symbol("["), symbol("]"), sepBy1(orderKey, symbol(","))),
      };
    case "offset":
    case "limit":
      return { kind: op.name, name: op, count: yield* atom };
    case "select":
    case "returning":
    case "insert":
    case "update":
      return { kind: op.name, name: op, entries: yield* record };
    case "first":
    case "count":
    case "exists":
    case "delete":
      return { kind: op.name, name: op };
    default:
      return { kind: "helper", name: op };
  }
});

const paramType: Parser<ParamType> = parser(function*() {
  const type = yield* name;
  const field = yield* optional(selector);
  const optionalType = (yield* optional(symbol("?"))) !== undefined;
  return field
    ? { kind: "field" as const, model: type, field, optional: optionalType }
    : { kind: "named" as const, name: type, optional: optionalType };
});

const param: Parser<Param> = parser(function*() {
  const paramName = yield* name;
  yield* symbol(":");
  return { name: paramName, type: yield* paramType };
});

const modelExpr: Parser<ModelExpr> = parser(function*() {
  const base = yield* choice(
    fields.map((fields) => ({ kind: "fields" as const, fields })),
    parameter.map((name) => ({ kind: "name" as const, name })),
  );
  return { base, ops: yield* many(op) };
});

const declaration: Parser<Declaration> = choice(
  parser(function*() {
    yield* keyword("type");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    return { kind: "enum" as const, name: id, members: yield* sepBy1(name, symbol("|")) };
  }),
  parser(function*() {
    yield* keyword("model");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    return { kind: "model" as const, name: id, body: yield* modelExpr };
  }),
  parser(function*() {
    yield* keyword("let");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    yield* keyword("fn");
    const param = yield* between(symbol("("), symbol(")"), parameter);
    yield* symbol("=>");
    return { kind: "helper" as const, name: id, param, body: yield* modelExpr };
  }),
  parser(function*() {
    yield* keyword("query");
    yield* commit();
    const id = yield* name;
    const params = yield* optional(between(symbol("("), symbol(")"), sepEndBy(param, symbol(","))));
    yield* symbol("=");
    const model = yield* name;
    return {
      kind: "query" as const,
      name: id,
      params: params ?? [],
      body: { model, ops: yield* many(op) },
    };
  }),
);

export const program = lex.complete(many(declaration));

export const parse = (source: string): Result<readonly Declaration[]> => parseResult(program, source);

export const tokens: readonly TokenRule[] = [
  { pattern: /\/\/[^\r\n]*/, kind: () => undefined },
  { pattern: strings, kind: "string" },
  {
    pattern: words,
    kind: (text) => ((keywords as readonly string[]).includes(text) ? "keyword" : "variable"),
  },
  { pattern: digits, kind: "number" },
  { pattern: /\|>|=>|==|!=|<=|>=|[=:?.|<>]/, kind: "operator" },
];
