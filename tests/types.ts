// Compile-time contracts, checked by pnpm typecheck.
import { type Check, check, get, pure, scoped, within } from "langkit";
import { type Body, create, type Declaration, type Reference, type Value } from "langkit/ir";
import { elaboration } from "langkit/ir/check";
import { records } from "langkit/operations/records";

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

const code = create<"number" | "boolean">();
const value: Value<"number" | "boolean"> = code.literal("number", 1);
void value;
// @ts-expect-error IR carries this language's type universe, not arbitrary labels.
code.literal("string", 1);
const binding = code.binding("x", "number");
code.ref(binding, "boolean");
// @ts-expect-error Instantiated references must still use the language's type universe.
code.ref(binding, "string");
// @ts-expect-error Language type universes cannot silently cross.
const other: Value<"text"> = value;
void other;

const coreOnly = create<"number" | "boolean">();
// @ts-expect-error Records are an opt-in operation feature, not part of the core builder.
coreOnly.record("record", []);
const recordFeature = records<"number" | "record">();
const recordLanguage = create<"number" | "record">().use(recordFeature);
const recordValue = recordLanguage.record("record", [{ name: "answer", value: recordLanguage.literal("number", 42) }]);
const selected: Value<"number" | "record"> = recordLanguage.field("number", recordValue, "answer");
void selected;
// @ts-expect-error Feature payloads are checked against the selected language universe.
recordLanguage.record("text", []);
// @ts-expect-error Custom feature values retain the language's payload universe.
const otherRecord: Value<"text"> = recordValue;
void otherRecord;

const pureCode = create<"number">();
const pureValue = pureCode.literal("number", 42);
function* declareAnswer(): Generator<Declaration<"number">, Reference<"number">, unknown> {
  return yield* pureCode.declare("answer", pureValue);
}
const pureBody: Body<"number"> = pureCode.body(function*() {
  return yield* declareAnswer();
});
void pureBody;
// @ts-expect-error The standalone generator body accepts Values, not Check computations.
pureCode.body(pure(pureValue));

const featureLanguage = create<"number" | "record">().use(records<"number" | "record">());
const codeBuilder = elaboration(featureLanguage);
const typedBinding = codeBuilder.binding("x", "number");
const typedReference: Value<"number" | "record"> = codeBuilder.ref(typedBinding);
const typedFeature: Value<"number" | "record"> = codeBuilder.field(
  "number",
  codeBuilder.record("record", [{ name: "answer", value: codeBuilder.literal("number", 42) }]),
  "answer",
);
const rawDeclaration: Generator<Declaration<"number" | "record">, Reference<"number" | "record">, unknown> = codeBuilder
  .declare("answer", codeBuilder.literal("number", 42));
const mixedBody: Check<Body<"number" | "record">> = codeBuilder.body(function*() {
  const ref = yield* codeBuilder.declare("answer", codeBuilder.literal("number", 42));
  const loaded = yield* check(function*() {
    return yield* pure(ref);
  });
  return loaded;
});
const checkedComputation: Check<Value<"number" | "record">> = codeBuilder.check(function*() {
  return typedReference;
});
const checkedScope: Check<Value<"number" | "record">> = codeBuilder.scope(function*() {
  return typedFeature;
});
void rawDeclaration;
void mixedBody;
void checkedComputation;
void checkedScope;
// @ts-expect-error Feature composition happens before elaboration; use is not exposed.
codeBuilder.use(records<"number" | "record">());
const directBody: Check<Body<"number" | "record">> = codeBuilder.body(pure(typedReference));
const directScope: Check<Value<"number" | "record">> = codeBuilder.scope(pure(typedFeature));
void directBody;
void directScope;
// @ts-expect-error Adapter declarations yield raw IR, not Check computations.
codeBuilder.declare("wrong", pure(typedReference));
