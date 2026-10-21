// Keep parsing semantics in parserator: cuts and backtracking are not checking.
import type { Parser } from "parserator";
import type { Result } from "./check.ts";

export * from "parserator";

export const parseResult = <A>(parser: Parser<A>, source: string): Result<A> => {
  const parsed = parser.parse(source);
  return parsed.success
    ? parsed
    : {
      success: false,
      errors: [{
        ...parsed.error.diagnostic,
        message: parsed.error.message,
        context: ["parsing", ...(parsed.error.diagnostic.context ?? [])],
      }],
    };
};
