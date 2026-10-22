import assert from "node:assert/strict";
import { test } from "node:test";
import { type Check, check, fail, pure, run } from "../src/check.ts";
import * as rank from "../src/types/higher-rank.ts";

const value = <A>(operation: Check<A>): A => {
  const result = run(operation);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  return result.value;
};

type Theory<T, V extends T, S> = {
  fresh(): V;
  fn(param: T, result: T): T;
  number: T;
  boolean: T;
  prune(type: T): T;
  mono(type: T): S;
  generalize(type: T, environment: Iterable<S>): S;
  instantiate(scheme: S): T;
  unify(left: T, right: T): Check<void>;
  free(type: T): ReadonlySet<unknown>;
};

test("prune follows links without compressing any node", () => {
  const middle: rank.Variable = { kind: "variable", level: 0, instance: rank.number };
  const start: rank.Variable = { kind: "variable", level: 0, instance: middle };
  assert.equal(rank.prune(start), rank.number);
  assert.equal(start.instance, middle);
});

const common = <T, V extends T, S>(name: string, theory: Theory<T, V, S>) => {
  test(`${name}: fresh and instantiation allocate new variables per call`, () => {
    value(check(function*() {
      const a = theory.fresh();
      const b = theory.fresh();
      assert.notEqual(a, b);
      const scheme = theory.generalize(theory.fn(a, a), []);
      const first = theory.instantiate(scheme);
      const second = theory.instantiate(scheme);
      const firstVariables = theory.free(first);
      const secondVariables = theory.free(second);
      assert.equal(firstVariables.size, 1);
      assert.equal(secondVariables.size, 1);
      assert.notEqual([...firstVariables][0], [...secondVariables][0]);
      yield* theory.unify(first, theory.fn(theory.number, theory.number));
      yield* theory.unify(second, theory.fn(theory.boolean, theory.boolean));
    }));
  });

  test(`${name}: solved environment schemes prevent over-generalization`, () => {
    value(check(function*() {
      const outer = theory.fresh();
      const inner = theory.fresh();
      const environment = [theory.mono(outer)];
      yield* theory.unify(outer, theory.fn(inner, inner));
      const scheme = theory.generalize(inner, environment);
      assert.equal(theory.instantiate(scheme), inner);
    }));
  });

  test(`${name}: failed compound unification restores links`, () => {
    const result = run(check(function*() {
      const variable = theory.fresh();
      yield* theory.unify(theory.fn(variable, theory.number), theory.fn(theory.boolean, theory.boolean)).recover();
      assert.equal(theory.prune(variable), variable);
    }));
    assert.equal(result.success, false);
  });

  test(`${name}: pruning a speculative linked chain is read-only`, () => {
    value(check(function*() {
      const first = theory.fresh();
      const second = theory.fresh();
      yield* theory.unify(first, second);
      const speculative = run(
        check(function*() {
          yield* theory.unify(second, theory.number);
          assert.equal(theory.prune(first), theory.number);
          return yield* fail("abandon speculative solution");
        }).atomic(),
      );
      assert.equal(speculative.success, false);
      assert.equal(theory.prune(first), second);
      assert.equal(theory.prune(second), second);
    }));
  });
};

common<rank.Type, rank.Variable, rank.Scheme>("Higher rank", rank);

test("Higher rank: a row's tail must lack the row's labels", () => {
  value(check(function*() {
    const open = rank.freshRow();
    assert.throws(() => rank.row(new Map([["x", rank.number]]), open), /must lack x/);
    const tail = rank.freshRow(["x"]);
    yield* rank.unify(rank.record(rank.row(new Map(), tail)), rank.record(rank.row(new Map([["y", rank.number]]))));
    assert.throws(() => rank.row(new Map([["y", rank.number]]), tail), /must lack y/);
    assert.equal(
      run(
        rank.unify(
          rank.record(rank.row(new Map(), rank.freshRow(["x"]))),
          rank.record(rank.row(new Map([["x", rank.number]]))),
        ),
      ).success,
      false,
    );
  }));
});

test("Higher rank: failed compound unification restores levels, links and lacks", () => {
  const result = run(check(function*() {
    const outer = rank.fresh(0);
    const inner = rank.fresh(3);
    const tail = rank.freshRow(["x"], 3);
    const structure = rank.record(rank.row(new Map([["x", inner]]), tail));
    yield* rank.unify(rank.fn(outer, rank.number), rank.fn(structure, rank.boolean)).recover();
    assert.equal(outer.instance, undefined);
    assert.equal(inner.level, 3);
    assert.equal(tail.level, 3);
    assert.deepEqual(tail.lacks, new Set(["x"]));
  }));
  assert.equal(result.success, false);
});

test("Higher rank: row freshening and instantiation copy absence constraints per call", () => {
  value(check(function*() {
    const firstTail = rank.freshRow(["x"], 2);
    const secondTail = rank.freshRow(["x"], 2);
    assert.notEqual(firstTail, secondTail);
    assert.notEqual(firstTail.lacks, secondTail.lacks);
    const a = rank.fresh(2);
    const record = rank.record(rank.row(new Map([["x", a]]), firstTail));
    const scheme = rank.generalize(rank.fn(record, record), []);
    const first = rank.instantiate(scheme, 1);
    const second = rank.instantiate(scheme, 1);
    if (
      first.kind !== "function" || second.kind !== "function" || first.param.kind !== "record"
      || first.result.kind !== "record" || second.param.kind !== "record"
    ) throw new Error("Expected record functions");
    const tail = first.param.row.tail!;
    assert.equal(tail, first.result.row.tail);
    assert.equal(tail.level, 1);
    assert.notEqual(tail, second.param.row.tail);
    assert.notEqual(tail.lacks, firstTail.lacks);
    assert.deepEqual(tail.lacks, new Set(["x"]));
    yield* rank.exclude(rank.row(new Map(), tail), ["y"]);
    assert.deepEqual(firstTail.lacks, new Set(["x"]));
    assert.deepEqual(second.param.row.tail?.lacks, new Set(["x"]));
    assert.equal(first.param.row.fields.get("x"), first.result.row.fields.get("x"));
  }));
});

test("Higher rank: reused subsumption reruns, and forall instantiation and rigid scopes are fresh per call", () => {
  value(check(function*() {
    const a = rank.generic("a");
    const identity = rank.forall([a], rank.fn(a, a));
    const subsume = rank.subsume(identity, identity);
    yield* subsume;
    yield* subsume;
    const first = rank.instantiateForall(identity);
    const second = rank.instantiateForall(identity);
    assert.notEqual([...rank.free(first)][0], [...rank.free(second)][0]);
    const firstRigid = rank.skolemize(rank.forall([a], a), 1);
    const secondRigid = rank.skolemize(rank.forall([a], a), 1);
    assert.notEqual(firstRigid, secondRigid);
    assert.equal(run(rank.unify(firstRigid, secondRigid)).success, false);
  }));
});

test("Higher rank: expectFunction instantiates polymorphism and rolls invalid expectations back", () => {
  const a = rank.generic("a");
  const operation = rank.expectFunction(rank.forall([a], rank.fn(a, a)));
  value(check(function*() {
    const first = yield* operation;
    const second = yield* operation;
    assert.equal(first.param, first.result);
    assert.notEqual(first.param, second.param);
  }));
  assert.equal(run(rank.expectFunction(rank.number)).success, false);
});

for (
  const [name, wrap] of [
    ["arrow", (type: rank.Type) => rank.fn(type, rank.number)],
    ["record", (type: rank.Type) => rank.record(rank.row(new Map([["value", type]])))],
    ["data", (type: rank.Type) => rank.data({ id: Symbol("Box"), name: "Box", arity: 1 }, [type])],
  ] as const
) {
  test(`Higher rank: outer links lower reachable ${name} metas before later rigid solving`, () => {
    value(check(function*() {
      const outer = rank.fresh();
      const inner = rank.fresh(2);
      yield* rank.unify(outer, wrap(inner));
      assert.equal(inner.level, 0);
      const a = rank.generic("a");
      const rigid = rank.skolemize(rank.forall([a], a), 1);
      assert.equal(run(rank.unify(inner, rigid)).success, false);
    }));
  });
}
