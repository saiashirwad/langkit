// Compile-time contracts, checked by pnpm typecheck.
import { check, get, pure, scoped, within, type Check } from "langkit"
import { create, type Value } from "langkit/ir"

const number = scoped(0)
const narrow = scoped<0>(0)
const computation: Check<string> = check(function* () {
  const value: number = yield* get(number)
  return String(value)
})
void computation

// @ts-expect-error A scoped slot cannot be rebound to a different type.
within(number, "wrong", pure(0))
// @ts-expect-error Scoped keys are invariant: a 0 slot cannot become a number slot.
const widened: typeof number = narrow
void widened

const code = create<"number" | "boolean">()
const value: Value<"number" | "boolean"> = code.literal("number", 1)
void value
// @ts-expect-error IR carries this language's type universe, not arbitrary labels.
code.literal("string", 1)
const binding = code.binding("x", "number")
code.ref(binding, "boolean")
// @ts-expect-error Instantiated references must still use the language's type universe.
code.ref(binding, "string")
// @ts-expect-error Language type universes cannot silently cross.
const other: Value<"text"> = value
void other
