import assert from "node:assert/strict";
import { test } from "node:test";
import { check, run, type Check } from "langkit";
import {
  number,
  boolean,
  string,
  fn,
  record,
  row,
  fresh,
  freshRow,
  prune,
  flatten,
  free,
  exclude,
  unify,
  mono,
  generalize,
  instantiate,
  show,
  data,
  generic,
  forall,
  substitute,
  instantiateForall,
  skolemize,
  subsume,
  type Type,
  type TypeConstructor,
} from "../examples/advanced/advanced-types.ts";

const accept = (body: Check<unknown>) => {
  const result = run(body);
  assert.ok(result.success, result.success ? "" : result.error.message);
};

const reject = (body: Check<unknown>, message: RegExp) => {
  const result = run(body);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, message);
};

const option: TypeConstructor = { id: Symbol("Option"), name: "Option", arity: 1 };

const identity = () => {
  const a = generic("a");
  return forall([a], fn(a, a));
};

const field = (label: string, type: Type) => record(row(new Map([[label, type]])));

test("advanced types: ordinary and row polymorphism freshen together", () => {
  const a = fresh();
  const r = freshRow(["x"]);
  const type = fn(record(row(new Map([["x", a]]), r)), a);
  const scheme = generalize(type, []);
  assert.equal(scheme.variables.size, 2);
  const first = instantiate(scheme, 2);
  const second = instantiate(scheme, 2);
  accept(unify(first, fn(field("x", number), number)));
  accept(
    unify(
      second,
      fn(
        record(
          row(
            new Map([
              ["x", boolean],
              ["y", string],
            ]),
          ),
        ),
        boolean,
      ),
    ),
  );
  assert.equal(show(type), "({ x: a | r } -> a) where r lacks x");
});

test("advanced types: generalization follows solved environment variables", () => {
  const outer = fresh();
  const inner = fresh();
  accept(unify(outer, fn(number, inner)));
  assert.equal(generalize(inner, [mono(outer)]).variables.size, 0);
  assert.equal(generalize(fn(fresh(), inner), [mono(outer)]).variables.size, 1);
});

test("advanced types: absence constraints survive instantiation and aliases", () => {
  const tail = freshRow();
  accept(exclude(row(new Map(), tail), ["flag"]));
  const type = record(row(new Map(), tail));
  const instance = instantiate(generalize(type, []));
  reject(unify(instance, field("flag", boolean)), /Duplicate field/);
  assert.equal(tail.instance, undefined);
});

test("advanced types: nominal ADTs compare identity, not spelling", () => {
  const other: TypeConstructor = { id: Symbol("Option"), name: "Option", arity: 1 };
  accept(unify(data(option, [number]), data(option, [number])));
  reject(unify(data(option, [number]), data(other, [number])), /Cannot unify/);
  reject(unify(data(option, [number]), data(option, [boolean])), /Cannot unify/);
  assert.throws(() => data(option, []), /expects 1 arguments/);
  assert.equal(show(data(option, [fn(number, boolean)])), "Option((number -> boolean))");
});

test("advanced types: data parameters participate in occurs checks and generalization", () => {
  const a = fresh();
  reject(unify(a, data(option, [a])), /Infinite type/);
  const b = fresh();
  const scheme = generalize(data(option, [b]), []);
  assert.equal(scheme.variables.size, 1);
  accept(unify(instantiate(scheme), data(option, [number])));
  accept(unify(instantiate(scheme), data(option, [boolean])));
});

test("advanced types: forall substitution respects binder identities and shadowing", () => {
  const a = generic("a");
  const shadow = generic("a");
  const type = fn(a, forall([shadow], fn(shadow, a)));
  assert.equal(
    show(
      substitute(
        type,
        new Map([
          [a, number],
          [shadow, boolean],
        ]),
      ),
    ),
    "(number -> (forall a. (a -> number)))",
  );
  assert.equal(
    show(substitute(forall([a], fn(a, a)), new Map([[a, number]]))),
    "(forall a. (a -> a))",
  );
});

test("advanced types: instantiation opens only outer explicit forall", () => {
  const a = generic("a");
  const nested = identity();
  const type = forall([a], fn(nested, a));
  const first = instantiateForall(type, 3);
  const second = instantiateForall(type, 3);
  assert.equal(first.kind, "function");
  assert.equal(second.kind, "function");
  if (first.kind === "function" && second.kind === "function") {
    assert.equal(first.param.kind, "forall");
    assert.notEqual(first.result, second.result);
    assert.equal(first.result.kind, "variable");
    if (first.result.kind === "variable") assert.equal(first.result.level, 3);
  }
  assert.equal(instantiate(mono(type)).kind, "forall");
});

test("advanced types: explicit forall alpha-equivalence and rigid disagreement", () => {
  const a = generic("a");
  const b = generic("b");
  accept(unify(forall([a], fn(a, a)), forall([b], fn(b, b))));
  reject(unify(forall([a], fn(a, a)), forall([b], fn(b, number))), /Cannot unify/);
  reject(unify(generic("a"), generic("a")), /Cannot unify/);
});

test("advanced types: predicative subsumption accepts rank-2 arguments", () => {
  const poly = identity();
  accept(subsume(poly, fn(number, number), 0));
  accept(subsume(poly, fn(boolean, boolean), 0));
  accept(subsume(fn(poly, number), fn(poly, number), 0));
  // A function accepting a monomorphic argument is usable when the caller supplies
  // a polymorphic one; the reverse direction is not safe.
  accept(subsume(fn(fn(number, number), number), fn(poly, number), 0));
  reject(subsume(fn(poly, number), fn(fn(number, number), number), 0), /Cannot unify/);
});

test("advanced types: a monomorphic identity cannot become an arbitrary forall", () => {
  const a = fresh();
  reject(subsume(fn(a, a), identity(), 0), /Skolem escape/);
  reject(subsume(fn(number, number), identity(), 0), /Cannot unify/);
  accept(subsume(identity(), identity(), 0));
});

test("advanced types: impredicative meta solving is rejected in both directions", () => {
  reject(unify(fresh(), identity()), /impredicative/);
  reject(unify(identity(), fresh()), /impredicative/);
  // An explicitly higher-rank function is not itself a forall.
  accept(unify(fresh(), fn(identity(), number)));
});

test("advanced types: skolems are rigid and may not escape directly", () => {
  const a = generic("a");
  const rigid = skolemize(forall([a], a), 1);
  reject(unify(fresh(0), rigid), /Skolem escape/);
  accept(unify(fresh(1), rigid));
  reject(unify(rigid, number), /Cannot unify/);
  reject(unify(rigid, skolemize(forall([a], a), 1)), /Cannot unify/);
});

for (const [name, wrap] of [
  ["function", (type: Type) => fn(type, number)],
  ["data", (type: Type) => data(option, [type])],
  ["record", (type: Type) => field("x", type)],
  ["forall body", (type: Type) => fn(forall([generic("unused")], type), number)],
] as const) {
  test(`advanced types: connecting an outer meta lowers nested ${name} metas`, () => {
    const inner = fresh(2);
    accept(unify(fresh(0), wrap(inner)));
    assert.equal(inner.level, 0);
    const a = generic("a");
    reject(unify(inner, skolemize(forall([a], a), 1)), /Skolem escape/);
  });
}

test("advanced types: skolem escape through a captured row tail is rejected", () => {
  const tail = freshRow([], 2);
  const type = record(row(new Map(), tail));
  accept(unify(fresh(0), type));
  assert.equal(tail.level, 0);
  const a = generic("a");
  reject(unify(type, field("value", skolemize(forall([a], a), 1))), /Skolem escape/);
});

test("advanced types: connecting row tails lowers nested type variables", () => {
  const tail = freshRow([], 0);
  const inner = fresh(2);
  accept(unify(record(row(new Map(), tail)), field("value", inner)));
  assert.equal(inner.level, 0);
  const a = generic("a");
  reject(unify(inner, skolemize(forall([a], a), 1)), /Skolem escape/);
});

test("advanced types: shared fresh row preserves the outer lexical level", () => {
  const first = freshRow(["x"], 2);
  const second = freshRow(["y"], 0);
  const left = record(row(new Map([["x", number]]), first));
  const right = record(row(new Map([["y", boolean]]), second));
  accept(unify(left, right));
  assert.equal(flatten(first.instance!).tail?.level, 0);
  assert.equal(flatten(second.instance!).tail?.level, 0);
});

for (const expected of [number, fn(number, number)]) {
  test(`advanced types: row unification checks newly exposed common fields (${show(expected)})`, () => {
    const r = freshRow();
    const s = freshRow(["x", "y"]);
    const rType = record(row(new Map(), r));
    // Matching x solves r to { y: boolean | s }, exposing y on the right.
    const left = record(
      row(
        new Map([
          ["x", rType],
          ["y", expected],
        ]),
        s,
      ),
    );
    const right = record(row(new Map([["x", record(row(new Map([["y", boolean]]), s))]]), r));
    reject(unify(left, right), /Cannot unify/);
  });
}

test("advanced types: equal newly exposed fields still unify", () => {
  const r = freshRow();
  const s = freshRow(["x", "y"]);
  const left = record(
    row(
      new Map([
        ["x", record(row(new Map(), r))],
        ["y", boolean],
      ]),
      s,
    ),
  );
  const right = record(row(new Map([["x", record(row(new Map([["y", boolean]]), s))]]), r));
  accept(unify(left, right));
});

test("advanced types: row and ordinary occurs checks cross record fields", () => {
  const a = fresh();
  reject(unify(a, field("x", a)), /Infinite type/);
  const tail = freshRow();
  const type = record(row(new Map(), tail));
  reject(unify(type, field("self", type)), /Infinite row/);
});

test("advanced types: rigid witnesses allocate per execution of reusable subsumption", () => {
  const operation = subsume(identity(), identity(), 0);
  accept(operation);
  accept(operation);
  const operationWithFresh = check(function* () {
    const variable = fresh();
    yield* unify(variable, number);
    return variable;
  });
  const first = run(operationWithFresh);
  const second = run(operationWithFresh);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value, second.value);
  assert.equal(prune(first.value), number);
  assert.equal(free(identity()).size, 0);
});
