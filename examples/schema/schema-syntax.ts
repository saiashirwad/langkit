import type { Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import {
  between,
  choice,
  commit,
  createLexemes,
  fail,
  many,
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
    | { readonly kind: "references"; readonly model: Name; readonly field: Name; }
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
    | { readonly kind: "helper"; }
  );

export type ModelExpr = {
  readonly base:
    | { readonly kind: "fields"; readonly fields: readonly Field[]; }
    | { readonly kind: "name"; readonly name: Name; };
  readonly ops: readonly ModelOp[];
};

export type Declaration =
  & { readonly name: Name; }
  & (
    | { readonly kind: "enum"; readonly members: readonly Name[]; }
    | { readonly kind: "model"; readonly body: ModelExpr; }
    | { readonly kind: "helper"; readonly param: Name; readonly body: ModelExpr; }
  );

const words = /[a-zA-Z_][a-zA-Z_0-9]*/;
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const digits = /-?\d+(?:\.\d+)?/;
const keywords = ["model", "type", "let", "fn", "true", "false"] as const;

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*)*/),
  identifier: regex(words),
  keywords,
});

const { keyword, symbol } = lex;

const named = (p: Parser<string>): Parser<Name> =>
  p.withSpan((name, span) => ({
    name,
    span: { start: span.start, end: span.start + name.length },
  }));
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
      return { kind: "references", name: op, model, field: yield* name };
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

const modelOp: Parser<ModelOp> = parser(function*() {
  yield* symbol("|>");
  yield* commit();
  const op = yield* name;
  if (op.name === "extend") return { kind: "extend", name: op, fields: yield* fields };
  if (op.name === "index" || op.name === "unique") {
    return {
      kind: op.name,
      name: op,
      fields: yield* between(symbol("["), symbol("]"), sepBy1(selector, symbol(","))),
    };
  }
  return { kind: "helper", name: op };
});

const modelExpr: Parser<ModelExpr> = parser(function*() {
  const base = yield* choice(
    fields.map((fields) => ({ kind: "fields" as const, fields })),
    parameter.map((name) => ({ kind: "name" as const, name })),
  );
  return { base, ops: yield* many(modelOp) };
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
);

export const program = lex.complete(many(declaration));

export const parse = (source: string): Result<readonly Declaration[]> => {
  const result = program.parse(source);
  return result.success
    ? result
    : {
      success: false,
      errors: [{
        ...result.error.diagnostic,
        message: result.error.message,
        context: ["parsing", ...(result.error.diagnostic.context ?? [])],
      }],
    };
};

export const tokens: readonly TokenRule[] = [
  { pattern: /\/\/[^\r\n]*/, kind: () => undefined },
  { pattern: strings, kind: "string" },
  {
    pattern: words,
    kind: (text) => ((keywords as readonly string[]).includes(text) ? "keyword" : "variable"),
  },
  { pattern: digits, kind: "number" },
  { pattern: /\|>|=>|[=:?.|]/, kind: "operator" },
];
