// Keep parsing semantics in parserator: cuts and backtracking are not checking.
import type { ParseError, Parser } from "parserator";
import type { Result } from "./check.ts";

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
