import { type Check, check } from "../src/check.ts";
import * as rank from "../src/types/higher-rank.ts";

const rankedProgram: Check<rank.Type> = check(function*() {
  const a: rank.Generic = rank.generic("a");
  const identity: rank.Type = rank.forall([a], rank.fn(a, a));
  const arrow = yield* rank.expectFunction(identity);
  const parameter: rank.Type = arrow.param;
  yield* rank.subsume(parameter, arrow.result);
  yield* rank.subsume(identity, rank.skolemize(identity, 1), 1);
  return identity;
});

// @ts-expect-error A language binding map is not an environment of schemes.
rank.generalize(rank.number, new Map([["x", { scheme: rank.mono(rank.number) }]]));
// @ts-expect-error Higher-rank metavariables require lexical levels.
const missingLevel: rank.Variable = { kind: "variable" };

void [rankedProgram, missingLevel];
