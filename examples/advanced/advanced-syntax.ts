import type { Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import type { Operator } from "langkit/ir";
import {
  between,
  choice,
  commit,
  createLexemes,
  many,
  many1,
  optional,
  type Parser,
  parser,
  postfix,
  precedence,
  recursive,
  regex,
  sepBy,
  sepBy1,
  sepEndBy,
} from "langkit/parse";

type Located<T> = T & { readonly span: Span; };

export type TypeExpr = Located<
  | { readonly kind: "name"; readonly name: string; readonly args: readonly TypeExpr[]; }
  | { readonly kind: "function"; readonly param: TypeExpr; readonly result: TypeExpr; }
  | { readonly kind: "forall"; readonly parameters: readonly string[]; readonly body: TypeExpr; }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly nameSpan: Span;
      readonly type: TypeExpr;
    }[];
  }
>;

export type Pattern = Located<
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly { readonly name: string; readonly span: Span; }[];
  }
  | { readonly kind: "binding"; readonly name: string; }
>;

export type Expr = Located<
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "boolean"; readonly value: boolean; }
  | { readonly kind: "string"; readonly value: string; }
  | { readonly kind: "name"; readonly name: string; }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: string;
      readonly nameSpan: Span;
      readonly value: Expr;
    }[];
    readonly base: Expr | undefined;
  }
  | { readonly kind: "field"; readonly record: Expr; readonly name: string; }
  | { readonly kind: "binary"; readonly op: Operator; readonly left: Expr; readonly right: Expr; }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly nameSpan: Span;
    readonly value: Expr;
    readonly body: Expr;
    readonly annotation: TypeExpr | undefined;
    readonly recursive: boolean;
  }
  | {
    readonly kind: "fn";
    readonly param: string;
    readonly paramSpan: Span;
    readonly body: Expr;
    readonly annotation: TypeExpr | undefined;
  }
  | { readonly kind: "call"; readonly fn: Expr; readonly arg: Expr; }
  | { readonly kind: "if"; readonly cond: Expr; readonly then: Expr; readonly else: Expr; }
  | { readonly kind: "annotated"; readonly value: Expr; readonly annotation: TypeExpr; }
  | {
    readonly kind: "match";
    readonly value: Expr;
    readonly cases: readonly {
      readonly pattern: Pattern;
      readonly body: Expr;
      readonly span: Span;
    }[];
  }
>;

export type DataDecl = {
  readonly name: string;
  readonly nameSpan: Span;
  readonly parameters: readonly string[];
  readonly constructors: readonly {
    readonly name: string;
    readonly nameSpan: Span;
    readonly fields: readonly TypeExpr[];
  }[];
  readonly span: Span;
};

export type Module = { readonly types: readonly DataDecl[]; readonly body: Expr; };

const words = /[a-zA-Z_]\w*/;
const digits = /\d+(?:\.\d+)?/;
const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const comments = /\/\/[^\r\n]*/;
const keywords = [
  "let",
  "in",
  "fn",
  "if",
  "then",
  "else",
  "true",
  "false",
  "type",
  "forall",
  "rec",
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

const named = (p: Parser<string>) =>
  p.withSpan((name, span) => ({
    name,
    span: { start: span.start, end: span.start + name.length },
  }));
const name = named(identifier);
const lower = identifier.validate(
  (text) => /^[a-z_]/.test(text),
  "Expected a lowercase binding name",
);
const upper = identifier.validate(
  (text) => /^[A-Z]/.test(text),
  "Expected an uppercase constructor or type name",
);
const bindingName = named(lower);
const constructorName = named(upper);

export const tokens: readonly TokenRule[] = [
  { pattern: comments, kind: () => undefined },
  { pattern: strings, kind: "string" },
  { pattern: words, kind: (text) => (reserved.has(text) ? "keyword" : "variable") },
  { pattern: digits, kind: "number" },
  { pattern: /==|=>|->|[+\-*/>=:|]/, kind: "operator" },
];

const typeExpression: Parser<TypeExpr> = recursive<TypeExpr>((type) => {
  const quantified: Parser<TypeExpr> = located(
    parser(function*() {
      yield* keyword("forall");
      yield* commit();
      const parameters = yield* many1(lower);
      yield* symbol(".");
      return { kind: "forall" as const, parameters, body: yield* type };
    }),
  );
  const record: Parser<TypeExpr> = located(
    parser(function*() {
      yield* symbol("{");
      yield* commit();
      const fields = yield* sepEndBy(
        parser(function*() {
          const label = yield* name;
          yield* symbol(":");
          return { name: label.name, nameSpan: label.span, type: yield* type };
        }),
        symbol(","),
      );
      yield* symbol("}");
      return { kind: "record" as const, fields };
    }),
  );
  const namedType: Parser<TypeExpr> = located(
    parser(function*() {
      const name = yield* identifier;
      const args = yield* optional(between(symbol("("), symbol(")"), sepBy1(type, symbol(","))));
      return { kind: "name" as const, name, args: args ?? [] };
    }),
  );
  const atom = choice(record, namedType, between(symbol("("), symbol(")"), type));
  const arrow = parser(function*() {
    const param = yield* atom;
    const result = yield* optional(
      parser(function*() {
        yield* symbol("->");
        yield* commit();
        return yield* type;
      }),
    );
    return result
      ? {
        kind: "function" as const,
        param,
        result,
        span: { start: param.span.start, end: result.span.end },
      }
      : param;
  });
  return choice(quantified, arrow);
});

const annotation = optional(
  parser(function*() {
    yield* symbol(":");
    yield* commit();
    return yield* typeExpression;
  }),
);

const pattern: Parser<Pattern> = choice(
  located(
    parser(function*() {
      const name = yield* upper;
      const fields = yield* optional(
        between(symbol("("), symbol(")"), sepBy1(bindingName, symbol(","))),
      );
      return { kind: "constructor" as const, name, fields: fields ?? [] };
    }),
  ),
  bindingName.map(({ name, span }): Pattern => ({ kind: "binding", name, span })),
);

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const binding: Parser<Expr> = located(
    parser(function*() {
      yield* keyword("let");
      yield* commit();
      const rec = yield* optional(keyword("rec"));
      const id = yield* bindingName;
      const type = yield* annotation;
      yield* symbol("=");
      const value = yield* expr;
      yield* keyword("in");
      return {
        kind: "let" as const,
        name: id.name,
        nameSpan: id.span,
        annotation: type,
        recursive: rec !== undefined,
        value,
        body: yield* expr,
      };
    }),
  );
  const lambda: Parser<Expr> = located(
    parser(function*() {
      yield* keyword("fn");
      yield* commit();
      yield* symbol("(");
      const param = yield* bindingName;
      const type = yield* annotation;
      yield* symbol(")");
      yield* symbol("=>");
      return {
        kind: "fn" as const,
        param: param.name,
        paramSpan: param.span,
        annotation: type,
        body: yield* expr,
      };
    }),
  );
  const conditional: Parser<Expr> = located(
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
  const match: Parser<Expr> = located(
    parser(function*() {
      yield* keyword("match");
      yield* commit();
      const value = yield* expr;
      yield* symbol("{");
      const cases = yield* sepEndBy(
        located(
          parser(function*() {
            const arm = yield* pattern;
            yield* symbol("=>");
            return { pattern: arm, body: yield* expr };
          }),
        ),
        symbol(","),
      );
      yield* symbol("}");
      return { kind: "match" as const, value, cases };
    }),
  );
  const records: Parser<Expr> = located(
    parser(function*() {
      yield* symbol("{");
      yield* commit();
      const fields = yield* sepBy(
        parser(function*() {
          const label = yield* name;
          yield* symbol("=");
          return { name: label.name, nameSpan: label.span, value: yield* expr };
        }),
        symbol(","),
      );
      const base = yield* optional(
        parser(function*() {
          yield* symbol("|");
          yield* commit();
          return yield* expr;
        }),
      );
      yield* symbol("}");
      return { kind: "record" as const, fields, base };
    }),
  );
  const grouped: Parser<Expr> = parser(function*() {
    yield* symbol("(");
    yield* commit();
    const value = yield* expr;
    const type = yield* annotation;
    yield* symbol(")");
    return { value, type };
  }).withSpan(
    ({ value, type }, span): Expr => type ? { kind: "annotated", value, annotation: type, span } : value,
  );
  const atom: Parser<Expr> = choice(
    records,
    located(
      lex
        .token(regex(strings))
        .map((text) => ({ kind: "string" as const, value: JSON.parse(text) as string })),
    ),
    located(
      lex
        .token(regex(new RegExp(`-?${digits.source}`)))
        .map((text) => ({ kind: "number" as const, value: Number(text) })),
    ),
    located(keyword("true").map(() => ({ kind: "boolean" as const, value: true }))),
    located(keyword("false").map(() => ({ kind: "boolean" as const, value: false }))),
    name.map(({ name, span }): Expr => ({ kind: "name", name, span })),
    grouped,
  );
  const calls = postfix(
    atom,
    choice(
      parser(function*() {
        yield* symbol(".");
        yield* commit();
        return yield* name;
      }).map(
        ({ name, span }) => (record: Expr): Expr => ({
          kind: "field",
          record,
          name,
          span: { start: record.span.start, end: span.end },
        }),
      ),
      between(symbol("("), symbol(")"), sepBy1(expr, symbol(","))).withSpan(
        (args, span) => (callee: Expr): Expr =>
          args.reduce<Expr>(
            (fn, arg) => ({
              kind: "call",
              fn,
              arg,
              span: { start: callee.span.start, end: span.end },
            }),
            callee,
          ),
      ),
    ),
  );
  const binary = (op: Operator) =>
    symbol(op).map(
      () => (left: Expr, right: Expr): Expr => ({
        kind: "binary",
        op,
        left,
        right,
        span: { start: left.span.start, end: right.span.end },
      }),
    );
  const operators = precedence(calls, [
    { associativity: "left", operators: [binary("*"), binary("/")] },
    { associativity: "left", operators: [binary("+"), binary("-")] },
    { associativity: "left", operators: [binary(">"), binary("==")] },
  ]);
  return choice(binding, lambda, conditional, match, operators);
});

const declaration: Parser<DataDecl> = located(
  parser(function*() {
    yield* keyword("type");
    yield* commit();
    const id = yield* constructorName;
    const parameters = yield* optional(
      between(symbol("("), symbol(")"), sepBy1(lower, symbol(","))),
    );
    yield* symbol("=");
    const constructors = yield* sepBy1(
      parser(function*() {
        const id = yield* constructorName;
        const fields = yield* optional(
          between(symbol("("), symbol(")"), sepBy1(typeExpression, symbol(","))),
        );
        return { name: id.name, nameSpan: id.span, fields: fields ?? [] };
      }),
      symbol("|"),
    );
    yield* optional(symbol(";"));
    return { name: id.name, nameSpan: id.span, parameters: parameters ?? [], constructors };
  }),
);

export const program: Parser<Module> = lex.complete(
  parser(function*() {
    const types = yield* many(declaration);
    return { types, body: yield* expression };
  }),
);
