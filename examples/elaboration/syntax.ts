import type { Span } from "langkit/diagnostic";
import {
  between,
  choice,
  commit,
  createLexemes,
  many1,
  optional,
  type Parser,
  parser,
  postfix,
  recursive,
  regex,
} from "langkit/parse";

export type Annotation =
  | { readonly kind: "name"; readonly name: string; }
  | { readonly kind: "function"; readonly param: Annotation; readonly result: Annotation; }
  | { readonly kind: "forall"; readonly names: readonly string[]; readonly body: Annotation; };
type Syntax =
  | { readonly kind: "number"; readonly value: number; }
  | { readonly kind: "boolean"; readonly value: boolean; }
  | { readonly kind: "name"; readonly name: string; }
  | { readonly kind: "hole"; }
  | {
    readonly kind: "fn";
    readonly name: string;
    readonly nameSpan: Span;
    readonly annotation?: Annotation;
    readonly body: Expr;
  }
  | { readonly kind: "let"; readonly name: string; readonly nameSpan: Span; readonly value: Expr; readonly body: Expr; }
  | { readonly kind: "call"; readonly callee: Expr; readonly argument: Expr; }
  | { readonly kind: "record"; readonly fields: readonly { readonly name: string; readonly value: Expr; }[]; }
  | { readonly kind: "field"; readonly base: Expr; readonly name: string; }
  | { readonly kind: "annotation"; readonly value: Expr; readonly annotation: Annotation; };
export type Expr = Syntax & { readonly span: Span; };

const lex = createLexemes({
  trivia: regex(/\s*/),
  identifier: regex(/[a-zA-Z_]\w*/),
  keywords: ["let", "fn", "true", "false", "forall", "number", "boolean"],
});
const { keyword, symbol, identifier } = lex;
const located = (p: Parser<Syntax>): Parser<Expr> => p.withSpan((node, span) => ({ ...node, span }));
const name = identifier.withSpan((name, span) => ({
  name,
  span: { start: span.start, end: span.start + name.length },
}));

const annotation: Parser<Annotation> = recursive<Annotation>((type) => {
  const quantified = parser(function*() {
    yield* keyword("forall");
    yield* commit();
    const names = yield* many1(identifier);
    yield* symbol(".");
    return { kind: "forall" as const, names, body: yield* type };
  });
  const atom = choice(
    keyword("number").map((): Annotation => ({ kind: "name", name: "number" })),
    keyword("boolean").map((): Annotation => ({ kind: "name", name: "boolean" })),
    identifier.map((name): Annotation => ({ kind: "name", name })),
    between(symbol("("), symbol(")"), type),
  );
  return choice(
    quantified,
    parser(function*() {
      const param = yield* atom;
      if (yield* optional(symbol("->"))) return { kind: "function" as const, param, result: yield* type };
      return param;
    }),
  );
});

const expression: Parser<Expr> = recursive<Expr>((expr) => {
  const lambda = located(parser(function*() {
    yield* keyword("fn");
    yield* commit();
    const parameter: { name: string; span: Span; annotation?: Annotation; } = yield* choice(
      parser(function*() {
        yield* symbol("(");
        const parameter = yield* name;
        const type = (yield* optional(symbol(":"))) ? yield* annotation : undefined;
        yield* symbol(")");
        return { ...parameter, ...(type === undefined ? {} : { annotation: type }) };
      }),
      name,
    );
    yield* symbol("=>");
    return {
      kind: "fn",
      name: parameter.name,
      nameSpan: parameter.span,
      ...(parameter.annotation === undefined ? {} : { annotation: parameter.annotation }),
      body: yield* expr,
    };
  }));
  const binding = located(parser(function*() {
    yield* keyword("let");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    const value = yield* expr;
    yield* symbol(";");
    return { kind: "let", name: id.name, nameSpan: id.span, value, body: yield* expr };
  }));
  const record = located(parser(function*() {
    yield* symbol("{");
    const fields: { name: string; value: Expr; }[] = [];
    if (!(yield* optional(symbol("}")))) {
      do {
        const id = yield* identifier;
        yield* symbol(":");
        fields.push({ name: id, value: yield* expr });
      } while (yield* optional(symbol(",")));
      yield* symbol("}");
    }
    return { kind: "record", fields };
  }));
  const grouped = parser(function*() {
    const start = yield* symbol("(").withSpan((_text, span) => span.start);
    const first = yield* expr;
    if (yield* optional(symbol(","))) {
      const second = yield* expr;
      const end = yield* symbol(")").withSpan((_text, span) => span.end);
      return {
        kind: "record" as const,
        fields: [{ name: "_1", value: first }, { name: "_2", value: second }],
        span: { start, end },
      };
    }
    yield* symbol(")");
    return first;
  });
  const atom = choice(
    located(lex.token(regex(/\d+/)).map((text) => ({ kind: "number", value: Number(text) }))),
    located(keyword("true").map(() => ({ kind: "boolean", value: true }))),
    located(keyword("false").map(() => ({ kind: "boolean", value: false }))),
    located(symbol("?").map(() => ({ kind: "hole" }))),
    record,
    grouped,
    name.map(({ name, span }): Expr => ({ kind: "name", name, span })),
  );
  const suffix = choice(
    between(symbol("("), symbol(")"), expr).withSpan((argument, span) => (callee: Expr): Expr => ({
      kind: "call",
      callee,
      argument,
      span: { start: callee.span.start, end: span.end },
    })),
    parser(function*() {
      yield* symbol(".");
      const id = yield* name;
      return (base: Expr): Expr => ({
        kind: "field",
        base,
        name: id.name,
        span: { start: base.span.start, end: id.span.end },
      });
    }),
    parser(function*() {
      yield* symbol(":");
      const type = yield* annotation.withSpan((value, span) => ({ value, span }));
      return (value: Expr): Expr => ({
        kind: "annotation",
        value,
        annotation: type.value,
        span: { start: value.span.start, end: type.span.end },
      });
    }),
  );
  return choice(binding, lambda, postfix(atom, suffix));
});

export const program = lex.complete(expression);
