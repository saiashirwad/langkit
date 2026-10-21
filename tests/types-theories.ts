import { type Check, check } from "../src/check.ts";
import * as rank from "../src/types/higher-rank.ts";
import * as hm from "../src/types/hm.ts";

const hmProgram: Check<hm.Scheme> = check(function*() {
  const a: hm.Variable = yield* hm.fresh();
  const scheme: hm.Scheme = yield* hm.generalize(hm.fn(a, a), [hm.mono(hm.number)]);
  const instance: hm.Type = yield* hm.instantiate(scheme);
  yield* hm.unify(instance, hm.fn(hm.number, hm.number));
  return scheme;
});

const rankedProgram: Check<rank.Type> = check(function*() {
  const a: rank.Generic = rank.generic("a");
  const identity: rank.Type = rank.forall([a], rank.fn(a, a));
  const arrow = yield* rank.expectFunction(identity);
  const parameter: rank.Type = arrow.param;
  yield* rank.subsume(parameter, arrow.result);
  return yield* rank.withRigidScope(
    identity,
    0,
    (rigid, level) => rank.subsume(identity, rigid, level).map(() => identity),
  );
});

// @ts-expect-error A language binding map is not an environment of schemes.
hm.generalize(hm.number, new Map([["x", { scheme: hm.mono(hm.number) }]]));
// @ts-expect-error Higher-rank metavariables require lexical levels.
const missingLevel: rank.Variable = { kind: "variable" };

void [hmProgram, rankedProgram, missingLevel];
