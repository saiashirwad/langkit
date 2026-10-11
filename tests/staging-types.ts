import { createStagingAdapter } from "langkit/adapters/staging";
import { create } from "langkit/ir";
import * as S from "../src/staging.ts";
import { emitProgram } from "../src/staging/javascript.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<A extends true> = A;
type NotAny<A> = 0 extends 1 & A ? false : true;
type NotNever<A> = [A] extends [never] ? false : true;
const one = S.number(1);
const record = S.object({ count: one, label: S.string("ok"), ready: S.boolean(true) });
const fn = S.arrow({
  params: [S.param("n", S.Number), S.param("label", S.String)],
  body: function*([n, label]) {
    const sum = S.binary("+", n, S.number(2));
    return S.object({ sum, label });
  },
});
const result = S.call(fn, one, S.string("value"));
const program = S.build(function*() {
  const known = yield* S.const("one", one);
  return known;
});
const unknownFn = S.arrow({
  params: [S.param("unknown", S.Unknown)],
  body: function*([unknown]) {
    return unknown;
  },
});
const unknownResult = S.call(unknownFn, one);
const ir = create<string>();
const adapter = createStagingAdapter<string>(
  { core: { literal: ir.coreDescriptors.literal } },
  guest => guest === "number" ? S.Number : S.Unknown,
);
const dynamic = adapter.lower(ir.program({ declarations: [], result: ir.literal("number", 1) }));
export type Contracts = [
  Assert<Equal<S.Denotes<typeof one>, 1>>,
  Assert<Equal<S.Denotes<typeof record>, { count: 1; label: "ok"; ready: true; }>>,
  Assert<Equal<S.Denotes<typeof fn>, (n: number, label: string) => { sum: number; label: string; }>>,
  Assert<Equal<S.Denotes<typeof result>, { sum: number; label: string; }>>,
  Assert<Equal<S.Denotes<typeof program.result>, 1>>,
  Assert<Equal<S.Denotes<typeof unknownResult>, unknown>>,
  Assert<NotAny<S.Denotes<typeof result>>>,
  Assert<NotNever<S.Denotes<typeof result>>>,
  Assert<Equal<typeof dynamic.program, S.Program<unknown>>>,
];
// @ts-expect-error invariant expression denotations are not interchangeable
const widened: S.Expr<number> = one;
// @ts-expect-error a boolean is not a numeric operand
S.binary("+", S.boolean(true), one);
// @ts-expect-error a string is not a numeric operand
S.binary("*", S.string("wrong"), one);
// @ts-expect-error typed parameter requires a genuine Type witness
S.param("n", 1);
S.arrow({
  // @ts-expect-error ordinary references cannot be used as parameter declarations
  params: [S.ref(S.param("n", S.Number))],
  body: function*() {
    return one;
  },
});
// @ts-expect-error typed call checks the first argument
S.call(fn, S.boolean(true), S.string("ok"));
// @ts-expect-error typed call checks the second argument
S.call(fn, one, S.number(2));
// @ts-expect-error typed call checks arity
S.call(fn, one);
// @ts-expect-error numbers are not callable
S.call(one);
// @ts-expect-error record fields require expressions
S.object({ count: 1 });
// @ts-expect-error field access checks exact known keys
S.prop(record, "missing");
// @ts-expect-error known field remains a literal numeric denotation
const wrongField: S.Expr<string> = S.prop(record, "count");
// @ts-expect-error annotation rejects a string initializer
S.const("n", S.string("wrong"), S.Number);
// @ts-expect-error unknown guest denotation is not numeric host proof
S.binary("+", unknownResult, one);
// @ts-expect-error emission requires the built program phase
emitProgram(one);
void widened;
void wrongField;
