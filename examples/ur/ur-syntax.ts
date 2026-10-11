import type { Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import type { Operator } from "langkit/ir";
import {
  between,
  choice,
  commit,
  createLexemes,
  many,
  notFollowedBy,
  optional,
  type Parser,
  parser,
  postfix,
  precedence,
  recursive,
  regex,
  sepEndBy,
} from "langkit/parse";

type Located<T> = T & { readonly span: Span; };

export type Name = { readonly name: string; readonly span: Span; };

export type KindExpr =
  | { readonly kind: "type"; }
  | { readonly kind: "row"; readonly element: KindExpr; }
  | { readonly kind: "arrow"; readonly param: KindExpr; readonly result: KindExpr; };

export type TypeExpr = Located<
  | { readonly kind: "name"; readonly name: string; }
  | { readonly kind: "application"; readonly fn: TypeExpr; readonly args: readonly TypeExpr[]; }
  | { readonly kind: "map"; readonly fn: TypeExpr; readonly row: TypeExpr; }
  | {
    readonly kind: "record";
    readonly fields: readonly { readonly name: Name; readonly type: TypeExpr; }[];
  }
  | { readonly kind: "record-of"; readonly row: TypeExpr; }
  | { readonly kind: "folder-of"; readonly row: TypeExpr; }
  | { readonly kind: "forall"; readonly generics: readonly Generic[]; readonly body: TypeExpr; }
  | { readonly kind: "concat"; readonly left: TypeExpr; readonly right: TypeExpr; }
  | { readonly kind: "function"; readonly params: readonly TypeExpr[]; readonly result: TypeExpr; }
>;

export type Generic = Name & { readonly kind: KindExpr; };

export type Parameter = Name & { readonly type: TypeExpr; };

export type Constraint = Located<{ readonly left: TypeExpr; readonly right: TypeExpr; }>;

export type Expr = Located<
  | { readonly kind: "block"; readonly statements: readonly Statement[]; }
  | { readonly kind: "folder"; readonly row: TypeExpr; readonly fields: readonly Name[]; }
  | { readonly kind: "literal"; readonly value: number | boolean | string; }
  | { readonly kind: "name"; readonly name: string; }
  | {
    readonly kind: "record";
    readonly fields: readonly { readonly name: Name; readonly value: Expr; }[];
  }
  | { readonly kind: "field"; readonly record: Expr; readonly name: Name; }
  | {
    readonly kind: "binary";
    readonly op: Operator | "++";
    readonly left: Expr;
    readonly right: Expr;
  }
  | {
    readonly kind: "call";
    readonly fn: Expr;
    readonly args: readonly Expr[];
    readonly typeArgs: readonly TypeExpr[] | undefined;
  }
  | { readonly kind: "lambda"; readonly params: readonly Parameter[]; readonly body: Expr; }
  | {
    readonly kind: "let";
    readonly name: Name;
    readonly annotation: TypeExpr | undefined;
    readonly value: Expr;
    readonly body: Expr;
  }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr; }
>;

export type Statement = Located<
  | {
    readonly kind: "binding";
    readonly name: Name;
    readonly annotation: TypeExpr | undefined;
    readonly value: Expr;
  }
  | { readonly kind: "expression"; readonly value: Expr; }
>;

export type Declaration = Located<
  | {
    readonly kind: "type";
    readonly name: Name;
    readonly generics: readonly Generic[];
    readonly resultKind: KindExpr | undefined;
    readonly body: TypeExpr;
  }
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
    readonly result: TypeExpr | undefined;
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
  "Folder",
  "folder",
  "forall",
  "Map",
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

const located = <T>(p: Parser<T>): Parser<Located<T>> => p.withSpan((value, span) => ({ ...value, span }));

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

const kindExpression: Parser<KindExpr> = recursive<KindExpr>((kind) => {
  const atom: Parser<KindExpr> = choice(
    keyword("Type").map(() => ({ kind: "type" as const })),
    parser(function*() {
      yield* keyword("Row");
      yield* symbol("<");
      const element = yield* kind;
      yield* symbol(">");
      return { kind: "row" as const, element };
    }),
    between(symbol("("), symbol(")"), kind),
  );
  return parser(function*() {
    const param = yield* atom;
    const result = yield* optional(
      parser(function*() {
        yield* symbol("->");
        yield* commit();
        return yield* kind;
      }),
    );
    return result ? { kind: "arrow" as const, param, result } : param;
  });
});

const genericParameters = between(
  symbol("<"),
  symbol(">"),
  commaList(
    parser(function*() {
      const id = yield* name;
      const kind = yield* optional(
        parser(function*() {
          yield* symbol(":");
          yield* commit();
          return yield* kindExpression;
        }),
      );
      return { ...id, kind: kind ?? { kind: "type" as const } };
    }),
  ),
);

export const annotation: Parser<TypeExpr> = recursive<TypeExpr>((type) => {
  const atom: Parser<TypeExpr> = choice(
    located(
      parser(function*() {
        yield* keyword("forall");
        yield* commit();
        const generics = yield* genericParameters;
        yield* symbol(".");
        return { kind: "forall" as const, generics, body: yield* type };
      }),
    ),
    located(
      parser(function*() {
        yield* keyword("Folder");
        yield* commit();
        yield* symbol("<");
        const row = yield* type;
        yield* symbol(">");
        return { kind: "folder-of" as const, row };
      }),
    ),
    located(
      parser(function*() {
        yield* keyword("Map");
        yield* commit();
        yield* symbol("<");
        const fn = yield* type;
        yield* symbol(",");
        const row = yield* type;
        yield* symbol(">");
        return { kind: "map" as const, fn, row };
      }),
    ),
    located(
      parser(function*() {
        yield* keyword("Record");
        yield* commit();
        yield* symbol("<");
        const row = yield* type;
        yield* symbol(">");
        return { kind: "record-of" as const, row };
      }),
    ),
    located(
      parser(function*() {
        yield* symbol("{");
        yield* commit();
        const fields = yield* commaList(
          parser(function*() {
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
    parser(function*() {
      const grouped = yield* between(symbol("("), symbol(")"), commaList(type)).withSpan(
        (params, span) => ({ params, span }),
      );
      const result = yield* optional(
        parser(function*() {
          yield* symbol("->");
          yield* commit();
          return yield* type;
        }),
      );
      if (result) {
        return {
          kind: "function" as const,
          params: grouped.params,
          result,
          span: { start: grouped.span.start, end: result.span.end },
        };
      }
      return yield* parser(function*() {
        return grouped.params;
      })
        .validate((params) => params.length === 1, "Expected a function arrow after parameter list")
        .map((params) => params[0]!);
    }),
  );
  const applied = postfix(
    atom,
    between(symbol("<"), symbol(">"), commaList(type)).withSpan(
      (args, span) => (fn: TypeExpr): TypeExpr => ({
        kind: "application",
        fn,
        args,
        span: { start: fn.span.start, end: span.end },
      }),
    ),
  );
  return precedence(applied, [
    {
      associativity: "left",
      operators: [
        symbol("++").map(
          () => (left: TypeExpr, right: TypeExpr): TypeExpr => ({
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
          () => (param: TypeExpr, result: TypeExpr): TypeExpr => ({
            kind: "function",
            params: [param],
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
    parser(function*() {
      const id = yield* name;
      yield* symbol(":");
      return { ...id, type: yield* annotation };
    }),
  ),
);

const optionalAnnotation = optional(
  parser(function*() {
    yield* symbol(":");
    yield* commit();
    return yield* annotation;
  }),
);

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const lambda = located(
    parser(function*() {
      yield* keyword("fn");
      yield* commit();
      const params = yield* parameters;
      yield* symbol("=>");
      return { kind: "lambda" as const, params, body: yield* expr };
    }),
  );
  const local = located(
    parser(function*() {
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
    parser(function*() {
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
      parser(function*() {
        yield* keyword("folder");
        yield* commit();
        const row = yield* between(symbol("<"), symbol(">"), annotation);
        const fields = yield* between(
          symbol("("),
          symbol(")"),
          commaList(
            parser(function*() {
              yield* symbol(".");
              return yield* name;
            }),
          ),
        );
        return { kind: "folder" as const, row, fields };
      }),
    ),
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
      parser(function*() {
        yield* symbol("{");
        yield* commit();
        const fields = yield* commaList(
          parser(function*() {
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
      parser(function*() {
        const typeArgs = yield* optional(between(symbol("<"), symbol(">"), commaList(annotation)));
        const args = yield* between(symbol("("), symbol(")"), commaList(expr));
        return { args, typeArgs };
      }).withSpan(
        ({ args, typeArgs }, span) => (fn: Expr): Expr => ({
          kind: "call",
          typeArgs,
          fn,
          args,
          span: { start: fn.span.start, end: span.end },
        }),
      ),
      parser(function*() {
        yield* symbol(".");
        yield* commit();
        return yield* name;
      }).map(
        (name) => (record: Expr): Expr => ({
          kind: "field",
          record,
          name,
          span: { start: record.span.start, end: name.span.end },
        }),
      ),
    ),
  );
  const binary = (op: Operator | "++") => {
    const token = op === "+"
      ? symbol("+").zipLeft(notFollowedBy(symbol("+")))
      : op === "-"
      ? symbol("-").zipLeft(notFollowedBy(symbol(">")))
      : symbol(op);
    return token.map(
      () => (left: Expr, right: Expr): Expr => ({
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

const block: Parser<Expr> = located(
  parser(function*() {
    yield* symbol("{");
    yield* commit();
    const statements = yield* many(
      choice(
        located(
          parser(function*() {
            yield* keyword("let");
            yield* commit();
            const id = yield* name;
            const annotation = yield* optionalAnnotation;
            yield* symbol("=");
            const value = yield* expression;
            yield* symbol(";");
            return { kind: "binding" as const, name: id, annotation, value };
          }),
        ),
        located(
          parser(function*() {
            const value = yield* expression;
            yield* symbol(";");
            return { kind: "expression" as const, value };
          }),
        ),
      ),
    );
    yield* symbol("}");
    return { kind: "block" as const, statements };
  }),
);

const declaration: Parser<Declaration> = choice(
  located(
    parser(function*() {
      yield* keyword("type");
      yield* commit();
      const id = yield* name;
      const generics = yield* optional(genericParameters);
      const resultKind = yield* optional(
        parser(function*() {
          yield* symbol(":");
          yield* commit();
          return yield* kindExpression;
        }),
      );
      yield* symbol("=");
      const body = yield* annotation;
      yield* symbol(";");
      return { kind: "type" as const, name: id, generics: generics ?? [], resultKind, body };
    }),
  ),
  located(
    parser(function*() {
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
    parser(function*() {
      yield* keyword("fn");
      yield* commit();
      const id = yield* name;
      const generics = yield* optional(genericParameters);
      const params = yield* parameters;
      const result = yield* optional(
        parser(function*() {
          yield* symbol("->");
          yield* commit();
          return yield* annotation;
        }),
      );
      const constraints = yield* optional(
        parser(function*() {
          yield* keyword("where");
          yield* commit();
          return yield* commaList(
            located(
              parser(function*() {
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
      const body = yield* choice(
        block,
        parser(function*() {
          yield* symbol("=");
          yield* commit();
          const body = yield* expression;
          yield* symbol(";");
          return body;
        }),
      );
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
