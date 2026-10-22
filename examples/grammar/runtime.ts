import type { Result } from "langkit";

/** Deep nesting overflows the stack of a recursive parser; the input is at fault, so it is a diagnostic. */
export const guarded = <A>(parse: () => Result<A>): Result<A> => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message)) {
      return { success: false, errors: [{ message: "Nesting is too deep to parse", context: [] }] };
    }
    throw error;
  }
};
