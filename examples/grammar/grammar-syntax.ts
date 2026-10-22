import type { Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import {
  choice,
  commit,
  createLexemes,
  fail,
  many,
  notFollowedBy,
  optional,
  type Parser,
  parser,
  parseResult,
  regex,
  sepBy1,
} from "langkit/parse";
import { guarded } from "./runtime.ts";

export type Name = { readonly name: string; readonly span: Span; };

export type SepOp = "sepBy" | "sepBy1" | "sepEndBy" | "sepEndBy1";

export type Expr =
  | { readonly kind: "lit"; readonly text: string; readonly span: Span; }
  | { readonly kind: "re"; readonly source: string; readonly span: Span; }
  | { readonly kind: "ref"; readonly name: Name; readonly span: Span; }
  | { readonly kind: "cut"; readonly span: Span; }
  | { readonly kind: "group"; readonly alts: readonly Alt[]; readonly span: Span; }
  | { readonly kind: "rep"; readonly op: "*" | "+" | "?"; readonly expr: Expr; readonly span: Span; }
  | {
    readonly kind: "sep";
    readonly op: SepOp;
    readonly item: Expr;
    readonly sep: Expr;
    readonly span: Span;
  }
  | { readonly kind: "pred"; readonly op: "&" | "!"; readonly expr: Expr; readonly span: Span; };

export type Elem = { readonly label: Name | undefined; readonly expr: Expr; };
export type Alt = { readonly tag: Name | undefined; readonly elems: readonly Elem[]; readonly span: Span; };

export type Assoc = "left" | "right" | "none" | "prefix" | "postfix";
export type Operator = { readonly text: string; readonly span: Span; };
export type Level = { readonly assoc: Assoc; readonly ops: readonly Operator[]; readonly span: Span; };
export type Body =
  | { readonly kind: "alts"; readonly alts: readonly Alt[]; }
  | { readonly kind: "precedence"; readonly levels: readonly Level[]; readonly atoms: readonly Alt[]; };

export type Pattern = { readonly source: string; readonly span: Span; };
export type Item =
  | { readonly kind: "skip"; readonly patterns: readonly Pattern[]; readonly span: Span; }
  | { readonly kind: "word"; readonly pattern: Pattern; readonly span: Span; }
  | { readonly kind: "token"; readonly name: Name; readonly pattern: Pattern; readonly span: Span; }
  | { readonly kind: "rule"; readonly name: Name; readonly body: Body; readonly span: Span; };
export type File = { readonly name: Name; readonly items: readonly Item[]; };

const reserved = ["grammar", "skip", "word", "token", "precedence"] as const;

const lex = createLexemes({
  trivia: regex(/(?:\s+|\/\/[^\r\n]*)*/),
  identifier: /[A-Za-z_][A-Za-z0-9_]*/,
  keywords: reserved,
});
const { keyword, symbol } = lex;

type Tok<T> = { readonly text: T; readonly span: Span; };
const at = <T extends string>(token: Parser<T>): Parser<Tok<T>> =>
  token.withSpan((text, span) => ({ text, span: { start: span.start, end: span.start + text.length } }));

/** A word that is meaningful only at one place, so it stays usable as a label or a rule name elsewhere. */
const contextual = <const W extends string>(word: W): Parser<Tok<W>> =>
  at(lex.token(regex(new RegExp(`${word}(?![A-Za-z0-9_])`))).map(() => word));

const name: Parser<Name> = at(lex.identifier).map(({ text, span }) => ({ name: text, span }));
const joined = (a: Span, b: Span): Span => ({ start: a.start, end: b.end });

const stringLiteral = at(lex.token(regex(/"(?:[^"\\\r\n]|\\.)*"/)));
const regexLiteral = at(lex.token(regex(/\/(?:[^\/\\\r\n\[]|\\.|\[(?:[^\]\\\r\n]|\\.)*\])+\//)));

const text = stringLiteral.map(({ text, span }) => ({ text: JSON.parse(text) as string, span }));
const pattern: Parser<Pattern> = regexLiteral.map(({ text, span }) => ({ source: text.slice(1, -1), span }));

const alts: Parser<readonly Alt[]> = parser(function*(): Generator<Parser<unknown>, readonly Alt[], never> {
  yield* optional(symbol("|"));
  return yield* sepBy1(alt, symbol("|"));
});

const primary: Parser<Expr> = choice<[Parser<Expr>, ...Parser<Expr>[]]>(
  text.map((lit): Expr => ({ kind: "lit", ...lit })),
  pattern.map((re): Expr => ({ kind: "re", ...re })),
  at(symbol("~")).map(({ span }): Expr => ({ kind: "cut", span })),
  parser(function*(): Generator<Parser<unknown>, Expr, never> {
    const open = yield* at(symbol("("));
    const inner = yield* alts;
    const close = yield* at(symbol(")"));
    return { kind: "group", alts: inner, span: joined(open.span, close.span) };
  }),
  parser(function*(): Generator<Parser<unknown>, Expr, never> {
    const ref = yield* name;
    yield* notFollowedBy(symbol("="));
    return { kind: "ref", name: ref, span: ref.span };
  }),
);

const predicate = choice(at(symbol("&")), at(symbol("!")));
const repetition = choice(at(symbol("*")), at(symbol("+")), at(symbol("?")));

const unary: Parser<Expr> = parser(function*(): Generator<Parser<unknown>, Expr, never> {
  const op = yield* optional(predicate);
  const expr = yield* primary;
  return op ? { kind: "pred", op: op.text, expr, span: joined(op.span, expr.span) } : expr;
});

const postfix: Parser<Expr> = parser(function*(): Generator<Parser<unknown>, Expr, never> {
  let expr = yield* unary;
  for (let mark = yield* optional(repetition); mark; mark = yield* optional(repetition)) {
    expr = { kind: "rep", op: mark.text, expr, span: joined(expr.span, mark.span) };
  }
  return expr;
});

const separators = ["sepBy1", "sepBy", "sepEndBy1", "sepEndBy"] as const;

const separated: Parser<Expr> = parser(function*(): Generator<Parser<unknown>, Expr, never> {
  const item = yield* postfix;
  const op = yield* optional(choice(...separators.map(contextual) as [Parser<Tok<SepOp>>, ...Parser<Tok<SepOp>>[]]));
  if (!op) return item;
  const sep = yield* postfix;
  return { kind: "sep", op: op.text, item, sep, span: joined(item.span, sep.span) };
});

const label: Parser<Name> = name.zipLeft(symbol(":"));

const elem: Parser<Elem> = parser(function*(): Generator<Parser<unknown>, Elem, never> {
  const named = yield* optional(label);
  return { label: named, expr: yield* separated };
});

const alt: Parser<Alt> = parser(function*(): Generator<Parser<unknown>, Alt, never> {
  const hash = yield* optional(at(symbol("#")));
  const tag = hash ? yield* name : undefined;
  const elems = yield* many(elem);
  if (!elems.length && !tag) yield* fail("expected a sequence");
  const first = hash?.span ?? elems[0]!.label?.span ?? elems[0]!.expr.span;
  const last = elems.at(-1)?.expr.span ?? tag!.span;
  return { tag, elems, span: joined(first, last) };
});

const associativities = ["left", "right", "none", "prefix", "postfix"] as const;

const level: Parser<Level> = parser(function*(): Generator<Parser<unknown>, Level, never> {
  const assoc = yield* choice(...associativities.map(contextual) as [Parser<Tok<Assoc>>, ...Parser<Tok<Assoc>>[]]);
  const ops = yield* sepBy1(text, symbol("|"));
  return { assoc: assoc.text, ops, span: joined(assoc.span, ops.at(-1)!.span) };
});

const body: Parser<Body> = choice<[Parser<Body>, ...Parser<Body>[]]>(
  parser(function*(): Generator<Parser<unknown>, Body, never> {
    yield* keyword("precedence");
    yield* commit();
    yield* symbol("{");
    const levels = yield* many(level);
    yield* contextual("atom");
    const atoms = yield* alts;
    yield* symbol("}");
    return { kind: "precedence", levels, atoms };
  }),
  alts.map((alts): Body => ({ kind: "alts", alts })),
);

const item: Parser<Item> = choice<[Parser<Item>, ...Parser<Item>[]]>(
  parser(function*(): Generator<Parser<unknown>, Item, never> {
    const start = yield* at(keyword("skip"));
    yield* commit();
    yield* symbol("=");
    const patterns = yield* sepBy1(pattern, symbol("|"));
    return { kind: "skip", patterns, span: joined(start.span, patterns.at(-1)!.span) };
  }),
  parser(function*(): Generator<Parser<unknown>, Item, never> {
    const start = yield* at(keyword("word"));
    yield* commit();
    yield* symbol("=");
    const word = yield* pattern;
    return { kind: "word", pattern: word, span: joined(start.span, word.span) };
  }),
  parser(function*(): Generator<Parser<unknown>, Item, never> {
    const start = yield* at(keyword("token"));
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    const re = yield* pattern;
    return { kind: "token", name: id, pattern: re, span: joined(start.span, re.span) };
  }),
  parser(function*(): Generator<Parser<unknown>, Item, never> {
    const id = yield* name;
    yield* symbol("=");
    yield* commit();
    const rhs = yield* body;
    return { kind: "rule", name: id, body: rhs, span: id.span };
  }),
);

const file: Parser<File> = lex.complete(parser(function*(): Generator<Parser<unknown>, File, never> {
  yield* keyword("grammar");
  yield* commit();
  const id = yield* name;
  return { name: id, items: yield* many(item) };
}));

export const parse = (source: string): Result<File> => guarded(() => parseResult(file, source));

const words = /[A-Za-z_][A-Za-z0-9_]*/;

export const tokens: readonly TokenRule[] = [
  { pattern: /\/\/[^\r\n]*/, kind: () => undefined },
  { pattern: /"(?:[^"\\\r\n]|\\.)*"/, kind: "string" },
  { pattern: /\/(?:[^\/\\\r\n\[]|\\.|\[(?:[^\]\\\r\n]|\\.)*\])+\//, kind: "macro" },
  {
    pattern: words,
    kind: (text) => (reserved as readonly string[]).includes(text) ? "keyword" : "variable",
  },
  { pattern: /[=|~#*+?&!:]/, kind: "operator" },
];
