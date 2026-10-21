import assert from "node:assert/strict";
import { test } from "node:test";
import { type Check, check, fail, pure, run } from "../src/check.ts";
import * as rank from "../src/types/higher-rank.ts";
import * as hm from "../src/types/hm.ts";

const value = <A>(operation: Check<A>): A => {
  const result = run(operation);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  return result.value;
};

type Theory<T, V extends T, S> = {
  fresh(): Check<V>;
  fn(param: T, result: T): T;
  number: T;
  boolean: T;
  prune(type: T): T;
  mono(type: T): S;
  generalize(type: T, environment: Iterable<S>): Check<S>;
  instantiate(scheme: S): Check<T>;
  unify(left: T, right: T): Check<void>;
  free(type: T): ReadonlySet<unknown>;
};

const common = <T, V extends T, S>(name: string, theory: Theory<T, V, S>) => {
  test(`${name}: reused fresh and instantiation allocate within each execution`, () => {
    value(check(function*() {
      const fresh = theory.fresh();
      const a = yield* fresh;
      const b = yield* fresh;
      assert.notEqual(a, b);
      const scheme = yield* theory.generalize(theory.fn(a, a), []);
      const instance = theory.instantiate(scheme);
      const first = yield* instance;
      const second = yield* instance;
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
      const outer = yield* theory.fresh();
      const inner = yield* theory.fresh();
      const environment = [theory.mono(outer)];
      yield* theory.unify(outer, theory.fn(inner, inner));
      const scheme = yield* theory.generalize(inner, environment);
      assert.equal(yield* theory.instantiate(scheme), inner);
    }));
  });

  test(`${name}: failed compound unification restores links`, () => {
    const result = run(check(function*() {
      const variable = yield* theory.fresh();
      yield* theory.unify(theory.fn(variable, theory.number), theory.fn(theory.boolean, theory.boolean)).recover();
      assert.equal(theory.prune(variable), variable);
    }));
    assert.equal(result.success, false);
  });

  test(`${name}: pruning a speculative linked chain is read-only`, () => {
    value(check(function*() {
      const first = yield* theory.fresh();
      const second = yield* theory.fresh();
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

common("HM", hm);
common<rank.Type, rank.Variable, rank.Scheme>("Higher rank", rank);

test("Higher rank: pure row construction acquires journaled unique-label constraints", () => {
  value(check(function*() {
    const tail = yield* rank.freshRow();
    const record = rank.record(rank.row(new Map([["x", rank.number]]), tail));
    yield* rank.unify(yield* rank.fresh(), record);
    assert.deepEqual(tail.lacks, new Set(["x"]));
    assert.equal(
      run(rank.unify(rank.record(rank.row(new Map(), tail)), rank.record(rank.row(new Map([["x", rank.number]])))))
        .success,
      false,
    );
  }));
});

test("Higher rank: failed compound unification restores levels, links and lacks", () => {
  const result = run(check(function*() {
    const outer = yield* rank.fresh(0);
    const inner = yield* rank.fresh(3);
    const tail = yield* rank.freshRow(["x"], 3);
    const structure = rank.record(rank.row(new Map([["x", inner]]), tail));
    yield* rank.unify(rank.fn(outer, rank.number), rank.fn(structure, rank.boolean)).recover();
    assert.equal(outer.instance, undefined);
    assert.equal(inner.level, 3);
    assert.equal(tail.level, 3);
    assert.deepEqual(tail.lacks, new Set(["x"]));
  }));
  assert.equal(result.success, false);
});

test("Higher rank: reused row freshening and instantiation retain copied absence constraints", () => {
  value(check(function*() {
    const fresh = rank.freshRow(["x"], 2);
    const firstTail = yield* fresh;
    const secondTail = yield* fresh;
    assert.notEqual(firstTail, secondTail);
    assert.notEqual(firstTail.lacks, secondTail.lacks);
    const a = yield* rank.fresh(2);
    const record = rank.record(rank.row(new Map([["x", a]]), firstTail));
    const scheme = yield* rank.generalize(rank.fn(record, record), []);
    const instantiate = rank.instantiate(scheme, 1);
    const first = yield* instantiate;
    const second = yield* instantiate;
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

test("Higher rank: reused subsumption, forall instantiation and rigid scopes execute independently", () => {
  value(check(function*() {
    const a = rank.generic("a");
    const identity = rank.forall([a], rank.fn(a, a));
    const subsume = rank.subsume(identity, identity);
    yield* subsume;
    yield* subsume;
    const instantiate = rank.instantiateForall(identity);
    const first = yield* instantiate;
    const second = yield* instantiate;
    assert.notEqual([...rank.free(first)][0], [...rank.free(second)][0]);
    const rigid = rank.withRigidScope(rank.forall([a], a), 0, (type) => pure(type));
    const firstRigid = yield* rigid;
    const secondRigid = yield* rigid;
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
      const outer = yield* rank.fresh();
      const inner = yield* rank.fresh(2);
      yield* rank.unify(outer, wrap(inner));
      assert.equal(inner.level, 0);
      const a = rank.generic("a");
      const rigid = yield* rank.skolemize(rank.forall([a], a), 1);
      assert.equal(run(rank.unify(inner, rigid)).success, false);
    }));
  });
}
