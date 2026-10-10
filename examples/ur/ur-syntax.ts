import {
  between,
  choice,
  commit,
  createLexemes,
  many,
  notFollowedBy,
  optional,
  parser,
  postfix,
  precedence,
  recursive,
  regex,
  sepEndBy,
  type Parser,
} from "langkit/parse";
import type { Span } from "langkit";
import type { Operator } from "langkit/ir";
import type { TokenRule } from "langkit/analysis";

type Located<T> = T & { readonly span: Span };

export type Name = { readonly name: string; readonly span: Span };

export type TypeExpr = Located<
  | { readonly kind: "name"; readonly name: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: Name; readonly type: TypeExpr }[];
    }
  | { readonly kind: "record-of"; readonly row: TypeExpr }
  | { readonly kind: "concat"; readonly left: TypeExpr; readonly right: TypeExpr }
  | { readonly kind: "function"; readonly param: TypeExpr; readonly result: TypeExpr }
>;

export type Generic = Name & { readonly row: boolean };

export type Parameter = Name & { readonly type: TypeExpr };

export type Constraint = Located<{ readonly left: TypeExpr; readonly right: TypeExpr }>;

export type Expr = Located<
  | { readonly kind: "literal"; readonly value: number | boolean | string }
  | { readonly kind: "name"; readonly name: string }
  | {
      readonly kind: "record";
      readonly fields: readonly { readonly name: Name; readonly value: Expr }[];
    }
  | { readonly kind: "field"; readonly record: Expr; readonly name: Name }
  | {
      readonly kind: "binary";
      readonly op: Operator | "++";
      readonly left: Expr;
      readonly right: Expr;
    }
  | { readonly kind: "call"; readonly fn: Expr; readonly args: readonly Expr[] }
  | { readonly kind: "lambda"; readonly params: readonly Parameter[]; readonly body: Expr }
  | {
      readonly kind: "let";
      readonly name: Name;
      readonly annotation: TypeExpr | undefined;
      readonly value: Expr;
      readonly body: Expr;
    }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr }
>;

export type Declaration = Located<
  | {
      readonly kind: "let";
      readonly name: Name;
      readonly annotation: TypeExpr | undefined;
      readonly value: Expr;
    }
  | {
      readonly kind: "function";
      readonly name: Name;
      readonly generics: readonly Generic[];
      readonly params: readonly Parameter[];
      readonly result: TypeExpr;
      readonly constraints: readonly Constraint[];
      readonly body: Expr;
    }
>;

const words = /[a-zA-Z_]\w*/;
const digits = /\d+(?:\.\d+)?/;
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const comments = /\/\/[^\r\n]*/;
const keywords = [
  "fn",
  "let",
  "in",
  "if",
  "then",
  "else",
  "true",
  "false",
  "where",
  "disjoint",
  "Record",
  "Row",
  "Type",
  "type",
  "match",
  "import",
] as const;
const reserved: ReadonlySet<string> = new Set(keywords);

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*)*/),
  identifier: regex(words),
  keywords,
});

const { keyword, symbol, identifier } = lex;

const located = <T>(p: Parser<T>): Parser<Located<T>> =>
  p.withSpan((value, span) => ({ ...value, span }));

const name = identifier.withSpan(
  (name, span): Name => ({ name, span: { start: span.start, end: span.start + name.length } }),
);

const commaList = <T>(p: Parser<T>) => sepEndBy(p, symbol(","));

export const tokens: readonly TokenRule[] = [
  { pattern: comments, kind: () => undefined },
  { pattern: strings, kind: "string" },
  { pattern: words, kind: (text) => (reserved.has(text) ? "keyword" : "variable") },
  { pattern: digits, kind: "number" },
  { pattern: /\+\+|==|=>|->|[+\-*/>=:]/, kind: "operator" },
];

export const annotation: Parser<TypeExpr> = recursive<TypeExpr>((type) => {
  const atom: Parser<TypeExpr> = choice(
    located(
      parser(function* () {
        yield* keyword("Record");
        yield* commit();
        yield* symbol("<");
        const row = yield* type;
        yield* symbol(">");
        return { kind: "record-of" as const, row };
      }),
    ),
    located(
      parser(function* () {
        yield* symbol("{");
        yield* commit();
        const fields = yield* commaList(
          parser(function* () {
            const id = yield* name;
            yield* symbol(":");
            return { name: id, type: yield* type };
          }),
        );
        yield* symbol("}");
        return { kind: "record" as const, fields };
      }),
    ),
    name.map(({ name, span }): TypeExpr => ({ kind: "name", name, span })),
    between(symbol("("), symbol(")"), type),
  );
  return precedence(atom, [
    {
      associativity: "left",
      operators: [
        symbol("++").map(
          () =>
            (left: TypeExpr, right: TypeExpr): TypeExpr => ({
              kind: "concat",
              left,
              right,
              span: { start: left.span.start, end: right.span.end },
            }),
        ),
      ],
    },
    {
      associativity: "right",
      operators: [
        symbol("->").map(
          () =>
            (param: TypeExpr, result: TypeExpr): TypeExpr => ({
              kind: "function",
              param,
              result,
              span: { start: param.span.start, end: result.span.end },
            }),
        ),
      ],
    },
  ]);
});

const parameters = between(
  symbol("("),
  symbol(")"),
  commaList(
    parser(function* () {
      const id = yield* name;
      yield* symbol(":");
      return { ...id, type: yield* annotation };
    }),
  ),
);

const optionalAnnotation = optional(
  parser(function* () {
    yield* symbol(":");
    yield* commit();
    return yield* annotation;
  }),
);

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const lambda = located(
    parser(function* () {
      yield* keyword("fn");
      yield* commit();
      const params = yield* parameters;
      yield* symbol("=>");
      return { kind: "lambda" as const, params, body: yield* expr };
    }),
  );
  const local = located(
    parser(function* () {
      yield* keyword("let");
      yield* commit();
      const id = yield* name;
      const annotation = yield* optionalAnnotation;
      yield* symbol("=");
      const value = yield* expr;
      yield* keyword("in");
      return { kind: "let" as const, name: id, annotation, value, body: yield* expr };
    }),
  );
  const conditional = located(
    parser(function* () {
      yield* keyword("if");
      yield* commit();
      const cond = yield* expr;
      yield* keyword("then");
      const then = yield* expr;
      yield* keyword("else");
      return { kind: "if" as const, cond, then, else: yield* expr };
    }),
  );
  const atom: Parser<Expr> = choice(
    located(
      lex
        .token(regex(new RegExp(`-?${digits.source}`)))
        .map((text) => ({ kind: "literal" as const, value: Number(text) })),
    ),
    located(
      lex
        .token(regex(strings))
        .map((text) => ({ kind: "literal" as const, value: JSON.parse(text) as string })),
    ),
    located(keyword("true").map(() => ({ kind: "literal" as const, value: true }))),
    located(keyword("false").map(() => ({ kind: "literal" as const, value: false }))),
    located(
      parser(function* () {
        yield* symbol("{");
        yield* commit();
        const fields = yield* commaList(
          parser(function* () {
            const id = yield* name;
            yield* symbol(":");
            return { name: id, value: yield* expr };
          }),
        );
        yield* symbol("}");
        return { kind: "record" as const, fields };
      }),
    ),
    name.map(({ name, span }): Expr => ({ kind: "name", name, span })),
    between(symbol("("), symbol(")"), expr),
  );
  const calls = postfix(
    atom,
    choice(
      between(symbol("("), symbol(")"), commaList(expr)).withSpan(
        (args, span) =>
          (fn: Expr): Expr => ({
            kind: "call",
            fn,
            args,
            span: { start: fn.span.start, end: span.end },
          }),
      ),
      parser(function* () {
        yield* symbol(".");
        yield* commit();
        return yield* name;
      }).map(
        (name) =>
          (record: Expr): Expr => ({
            kind: "field",
            record,
            name,
            span: { start: record.span.start, end: name.span.end },
          }),
      ),
    ),
  );
  const binary = (op: Operator | "++") => {
    const token =
      op === "+"
        ? symbol("+").zipLeft(notFollowedBy(symbol("+")))
        : op === "-"
          ? symbol("-").zipLeft(notFollowedBy(symbol(">")))
          : symbol(op);
    return token.map(
      () =>
        (left: Expr, right: Expr): Expr => ({
          kind: "binary",
          op,
          left,
          right,
          span: { start: left.span.start, end: right.span.end },
        }),
    );
  };
  return choice(
    local,
    lambda,
    conditional,
    precedence(calls, [
      { associativity: "left", operators: [binary("*"), binary("/")] },
      { associativity: "left", operators: [binary("++"), binary("+"), binary("-")] },
      { associativity: "left", operators: [binary(">"), binary("==")] },
    ]),
  );
});

const declaration: Parser<Declaration> = choice(
  located(
    parser(function* () {
      yield* keyword("let");
      yield* commit();
      const id = yield* name;
      const annotation = yield* optionalAnnotation;
      yield* symbol("=");
      const value = yield* expression;
      yield* symbol(";");
      return { kind: "let" as const, name: id, annotation, value };
    }),
  ),
  located(
    parser(function* () {
      yield* keyword("fn");
      yield* commit();
      const id = yield* name;
      const generics = yield* optional(
        between(
          symbol("<"),
          symbol(">"),
          commaList(
            parser(function* () {
              const id = yield* name;
              const row = yield* optional(
                parser(function* () {
                  yield* symbol(":");
                  yield* commit();
                  return yield* choice(
                    keyword("Type").map(() => false),
                    parser(function* () {
                      yield* keyword("Row");
                      yield* symbol("<");
                      yield* keyword("Type");
                      yield* symbol(">");
                      return true;
                    }),
                  );
                }),
              );
              return { ...id, row: row ?? false };
            }),
          ),
        ),
      );
      const params = yield* parameters;
      yield* symbol("->");
      const result = yield* annotation;
      const constraints = yield* optional(
        parser(function* () {
          yield* keyword("where");
          yield* commit();
          return yield* commaList(
            located(
              parser(function* () {
                yield* keyword("disjoint");
                yield* symbol("(");
                const left = yield* annotation;
                yield* symbol(",");
                const right = yield* annotation;
                yield* symbol(")");
                return { left, right };
              }),
            ),
          );
        }),
      );
      yield* symbol("=");
      const body = yield* expression;
      yield* symbol(";");
      return {
        kind: "function" as const,
        name: id,
        generics: generics ?? [],
        params,
        result,
        constraints: constraints ?? [],
        body,
      };
    }),
  ),
);

export const program = lex.complete(many(declaration));
