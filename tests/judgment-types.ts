import { pure, type Check } from "../src/check.ts";
import { createJudgments, type RuleTable, type Synthesized } from "../src/judgments.ts";
import type { CheckedArtifact } from "../src/elaboration.ts";

type N = { kind: "num"; value: number } | { kind: "ref"; name: string };
const table: RuleTable<N, string, number> = {
  num: { mode: "synth", check: "fromSynth", *synth(n) {
    const value: number = n.value;
    // @ts-expect-error narrowed node has no name
    n.name;
    return { type: "number", term: value };
  } },
  ref: { mode: "checkingOnly", *check(n, expected, j) {
    const name: string = n.name;
    const result: Synthesized<string, number> = yield* j.synth({ kind: "num", value: name.length });
    // @ts-expect-error precise yield result
    const bad: boolean = result.term;
    return expected.length;
  } },
};
// @ts-expect-error exhaustive tables require ref
const missing: RuleTable<N, string, number> = { num: table.num };
const wrong: RuleTable<N, string, number> = {
  // @ts-expect-error synthesis must return configured term type
  num: { mode: "synth", check: "fromSynth", *synth() { return { type: "number", term: false }; } },
  ref: table.ref,
};
const j = createJudgments(table, { modes: { enter: (expected, body) => body(expected), accept: (actual) => pure(actual.term) } });
const concrete: Check<Synthesized<string, number>> = j.synth({ kind: "num", value: 1 });
type IsAny<T> = 0 extends (1 & T) ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
const noAnyTerm: NotAny<Synthesized<string, number>["term"]> = true;
// @ts-expect-error configured expected type is string
j.check({ kind: "num", value: 1 }, false);
// @ts-expect-error consumers cannot construct the private publication brand
const forged: CheckedArtifact<number> = { value: 1 };
declare const checked: CheckedArtifact<number>;
// @ts-expect-error spreading a checked artifact cannot carry its private nominal proof
const altered: CheckedArtifact<number> = { ...checked, value: 2 };
void [missing, wrong, concrete, forged, altered, noAnyTerm];
