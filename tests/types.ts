// Compile-time contracts, checked by pnpm typecheck.
import { type Check, check, get, pure, scoped, within } from "langkit";
import * as ir from "langkit/ir";
import type { Body, Reference, Value } from "langkit/ir";

const number = scoped(0);
const narrow = scoped<0>(0);
const computation: Check<string> = check(function*() {
  const value: number = yield* get(number);
  return String(value);
});
void computation;

// @ts-expect-error A scoped slot cannot be rebound to a different type.
within(number, "wrong", pure(0));
// @ts-expect-error Scoped keys are invariant: a 0 slot cannot become a number slot.
const widened: typeof number = narrow;
void widened;

type Small = "number" | "boolean";
const value: Value<Small> = ir.literal<Small>("number", 1);
void value;
// @ts-expect-error IR carries this language's type universe, not arbitrary labels.
ir.literal<Small>("string", 1);
const binding = ir.binding<Small>("x", "number");
const instantiated: Value<Small> = ir.ref(binding, "boolean");
void instantiated;
// @ts-expect-error Instantiated references must still use the language's type universe.
const escaped: Value<Small> = ir.ref(binding, "string");
void escaped;
// @ts-expect-error Language type universes cannot silently cross.
const other: Value<"text"> = value;
void other;

const recordValue = ir.record<"number" | "record">("record", [{ name: "answer", value: ir.literal("number", 42) }]);
const selected: Value<"number" | "record"> = ir.field("number", recordValue, "answer");
void selected;
// @ts-expect-error Record values retain the language's payload universe.
const otherRecord: Value<"text"> = recordValue;
void otherRecord;

const answer: Check<Reference<"number">> = ir.declare("answer", ir.literal<"number">("number", 42));
const answerBody: Check<Body<"number">> = ir.body(answer);
const answerScope: Check<Value<"number">> = ir.scope(answer);
void answerBody;
void answerScope;
// @ts-expect-error A body collects a checked value, not a bare one.
ir.body(ir.literal("number", 42));
// @ts-expect-error Declarations take IR values, not checks.
ir.declare("wrong", answer);
