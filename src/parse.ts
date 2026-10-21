// Keep parsing semantics in parserator: cuts and backtracking are not checking.
import type { ParseError, Parser } from "parserator";
import type { Result } from "./check.ts";
import type { Span } from "./diagnostic.ts";

export * from "parserator";

const failed = (error: ParseError): Result<never> => ({
  success: false,
  errors: [{
    ...error.diagnostic,
    message: error.message,
    context: ["parsing", ...(error.diagnostic.context ?? [])],
  }],
});

export const parseResult = <A>(parser: Parser<A>, source: string): Result<A> => {
  const parsed = parser.parse(source);
  return parsed.success ? parsed : failed(parsed.error);
};

/** Parses a leading fragment and ignores the rest of the input. */
export const parsePrefixResult = <A>(parser: Parser<A>, source: string): Result<A> => {
  const parsed = parser.parsePrefix(source);
  return parsed.success ? { success: true, value: parsed.value.value } : failed(parsed.error);
};

export type Located<T> = T & { readonly span: Span; };

export const located = <T extends object>(parser: Parser<T>): Parser<Located<T>> =>
  parser.withSpan((value, span) => ({ ...value, span }));

export const named = (parser: Parser<string>): Parser<Located<{ readonly name: string; }>> =>
  parser.withSpan((name, span) => ({ name, span: { start: span.start, end: span.start + name.length } }));
