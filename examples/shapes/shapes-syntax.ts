import type { Diagnostic, Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import { choice, commit, createLexemes, many, type Parser, parser, recursive, regex } from "langkit/parse";

export type Form =
  & (
    | { readonly kind: "symbol"; readonly value: string; }
    | { readonly kind: "string"; readonly value: string; }
    | { readonly kind: "list" | "vector" | "record"; readonly items: readonly Form[]; }
  )
  & { readonly span: Span; };

const strings = /"(?:[^"\\\x00-\x1f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/;
const atoms = /[^\s()\[\]{}";]+/;
const lex = createLexemes({ trivia: regex(/(?:\s|;[^\n]*(?:\n|$))*/), identifier: regex(atoms), keywords: [] });
const form: Parser<Form> = recursive<Form>((form) => {
  const group = (open: string, close: string, kind: "list" | "vector" | "record"): Parser<Form> =>
    parser(function*() {
      yield* lex.symbol(open);
      yield* commit();
      const items = yield* many(form);
      yield* lex.symbol(close);
      return { kind, items };
    }).withSpan((node, span) => ({ ...node, span }));
  return choice(
    group("(", ")", "list"),
    group("[", "]", "vector"),
    group("{", "}", "record"),
    lex.token(regex(strings)).withSpan((text, span): Form => ({ kind: "string", value: JSON.parse(text), span })),
    lex.token(regex(atoms)).withSpan((value, span): Form => ({ kind: "symbol", value, span })),
  );
});

export const program = lex.complete(many(form));
export const parse = (source: string): Result<readonly Form[]> => {
  const result = program.parse(source);
  if (result.success) return result;
  const errors: [Diagnostic, ...Diagnostic[]] = [{
    ...result.error.diagnostic,
    message: result.error.message,
    context: ["parsing", ...(result.error.diagnostic.context ?? [])],
  }];
  return { success: false, errors };
};
const keywords = new Set([
  "shape",
  "def",
  "macro",
  "fn",
  "let",
  "if",
  ".",
  "extend",
  "update",
  "select",
  "merge",
  "true",
  "false",
]);
export const tokens: readonly TokenRule[] = [
  { pattern: /;[^\n]*/, kind: () => undefined },
  { pattern: strings, kind: "string" },
  { pattern: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, kind: "number" },
  { pattern: atoms, kind: (text) => keywords.has(text) ? "keyword" : "variable" },
];
