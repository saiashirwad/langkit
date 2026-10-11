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
  fresh as freshCheck,
  freshRow as freshRowCheck,
  prune,
  flatten,
  free,
  exclude,
  unify,
  mono,
  generalize as generalizeCheck,
  instantiate as instantiateCheck,
  show,
  data as dataCheck,
  generic,
  forall,
  substitute as substituteCheck,
  instantiateForall as instantiateForallCheck,
  skolemize as skolemizeCheck,
  subsume,
  typeKind,
  kindArrow,
  freshKind as freshKindCheck,
  pruneKind,
  unifyKinds,
  showKind,
  kindOf,
  apply,
  constructorType,
  decompose,
  qualified,
  sameType,
  defaultKind,
  type Type,
  type TypeConstructor,
  type Scheme,
  type Generic,
} from "../examples/strict/strict-types.ts";

const value = <A>(body: Check<A>): A => {
  const result = run(body);
  assert.ok(result.success, result.success ? "" : result.errors[0].message);
  return result.value;
};

const fresh = (level = 0, kind?: Parameters<typeof freshCheck>[1]) => value(freshCheck(level, kind));
const freshRow = (lacks: Iterable<string> = [], level = 0) => value(freshRowCheck(lacks, level));
const freshKind = () => value(freshKindCheck());
const data = (constructor: TypeConstructor, args: readonly Type[]): Type => value(dataCheck(constructor, args));
const substitute = (type: Type, replacements: ReadonlyMap<Generic, Type>): Type =>
  value(substituteCheck(type, replacements));
const generalize = (type: Type, environment: Iterable<Scheme>) => value(generalizeCheck(type, environment));
const instantiate = (scheme: Scheme, level = 0) => value(instantiateCheck(scheme, level));
const instantiateForall = (type: Type, level = 0) => value(instantiateForallCheck(type, level));
const skolemize = (type: Type, level: number) => value(skolemizeCheck(type, level));

const accept = (body: Check<unknown>) => {
  const result = run(body);
  assert.ok(result.success, result.success ? "" : result.errors[0].message);
};

const reject = (body: Check<unknown>, message: RegExp) => {
  const result = run(body);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.errors[0].message, message);
};

const option: TypeConstructor = { id: Symbol("Option"), name: "Option", arity: 1 };

const identity = () => {
  const a = generic("a");
  return forall([a], fn(a, a));
};

const field = (label: string, type: Type) => record(row(new Map([[label, type]])));

test("strict types: fresh allocations run per checker execution", () => {
  const operation = freshCheck();
  const first = run(operation);
  const second = run(operation);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value, second.value);
});

test("strict types: instantiation allocates per checker execution", () => {
  const scheme = value(generalizeCheck(fn(fresh(), fresh()), []));
  const operation = instantiateCheck(scheme);
  const first = run(operation);
  const second = run(operation);
  assert.ok(first.success && second.success);
  assert.notEqual(first.value, second.value);
});

test("strict types: ordinary and row polymorphism freshen together", () => {
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

test("strict types: generalization follows solved environment variables", () => {
  const outer = fresh();
  const inner = fresh();
  accept(unify(outer, fn(number, inner)));
  assert.equal(generalize(inner, [mono(outer)]).variables.size, 0);
  assert.equal(generalize(fn(fresh(), inner), [mono(outer)]).variables.size, 1);
});

test("strict types: absence constraints survive instantiation and aliases", () => {
  const tail = freshRow();
  accept(exclude(row(new Map(), tail), ["flag"]));
  const type = record(row(new Map(), tail));
  const instance = instantiate(generalize(type, []));
  reject(unify(instance, field("flag", boolean)), /Duplicate field/);
  assert.equal(tail.instance, undefined);
});

test("strict constraints: failed nested kind and type constraints roll back links", () => {
  const kind = freshKind();
  reject(
    unifyKinds(kindArrow(kind, typeKind), kindArrow(typeKind, kindArrow(typeKind, typeKind))),
    /Kind mismatch/,
  );
  assert.equal(kind.kind, "kind-variable");

  const variable = fresh();
  reject(unify(fn(variable, number), fn(boolean, string)), /Cannot unify/);
  assert.equal(prune(variable), variable);
});


test("strict types: nominal ADTs compare identity, not spelling", () => {
  const other: TypeConstructor = { id: Symbol("Option"), name: "Option", arity: 1 };
  accept(unify(data(option, [number]), data(option, [number])));
  reject(unify(data(option, [number]), data(other, [number])), /Cannot unify/);
  reject(unify(data(option, [number]), data(option, [boolean])), /Cannot unify/);
  assert.equal(show(data(option, [])), "Option");
  assert.throws(() => data(option, [number, boolean]), /Kind mismatch/);
  assert.equal(show(data(option, [fn(number, boolean)])), "Option((number -> boolean))");
});

test("strict types: data parameters participate in occurs checks and generalization", () => {
  const a = fresh();
  reject(unify(a, data(option, [a])), /Infinite type/);
  const b = fresh();
  const scheme = generalize(data(option, [b]), []);
  assert.equal(scheme.variables.size, 1);
  accept(unify(instantiate(scheme), data(option, [number])));
  accept(unify(instantiate(scheme), data(option, [boolean])));
});

test("strict types: forall substitution respects binder identities and shadowing", () => {
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

test("strict types: instantiation opens only outer explicit forall", () => {
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

test("strict types: explicit forall alpha-equivalence and rigid disagreement", () => {
  const a = generic("a");
  const b = generic("b");
  accept(unify(forall([a], fn(a, a)), forall([b], fn(b, b))));
  reject(unify(forall([a], fn(a, a)), forall([b], fn(b, number))), /Cannot unify/);
  reject(unify(generic("a"), generic("a")), /Cannot unify/);
});

test("strict types: predicative subsumption accepts rank-2 arguments", () => {
  const poly = identity();
  accept(subsume(poly, fn(number, number), 0));
  accept(subsume(poly, fn(boolean, boolean), 0));
  accept(subsume(fn(poly, number), fn(poly, number), 0));
  // A function accepting a monomorphic argument is usable when the caller supplies
  // a polymorphic one; the reverse direction is not safe.
  accept(subsume(fn(fn(number, number), number), fn(poly, number), 0));
  reject(subsume(fn(poly, number), fn(fn(number, number), number), 0), /Cannot unify/);
});

test("strict types: a monomorphic identity cannot become an arbitrary forall", () => {
  const a = fresh();
  reject(subsume(fn(a, a), identity(), 0), /Skolem escape/);
  reject(subsume(fn(number, number), identity(), 0), /Cannot unify/);
  accept(subsume(identity(), identity(), 0));
});

test("strict types: impredicative meta solving is rejected in both directions", () => {
  reject(unify(fresh(), identity()), /impredicative/);
  reject(unify(identity(), fresh()), /impredicative/);
  // An explicitly higher-rank function is not itself a forall.
  accept(unify(fresh(), fn(identity(), number)));
});

test("strict types: skolems are rigid and may not escape directly", () => {
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
  test(`strict types: connecting an outer meta lowers nested ${name} metas`, () => {
    const inner = fresh(2);
    accept(unify(fresh(0), wrap(inner)));
    assert.equal(inner.level, 0);
    const a = generic("a");
    reject(unify(inner, skolemize(forall([a], a), 1)), /Skolem escape/);
  });
}

test("strict types: skolem escape through a captured row tail is rejected", () => {
  const tail = freshRow([], 2);
  const type = record(row(new Map(), tail));
  accept(unify(fresh(0), type));
  assert.equal(tail.level, 0);
  const a = generic("a");
  reject(unify(type, field("value", skolemize(forall([a], a), 1))), /Skolem escape/);
});

test("strict types: connecting row tails lowers nested type variables", () => {
  const tail = freshRow([], 0);
  const inner = fresh(2);
  accept(unify(record(row(new Map(), tail)), field("value", inner)));
  assert.equal(inner.level, 0);
  const a = generic("a");
  reject(unify(inner, skolemize(forall([a], a), 1)), /Skolem escape/);
});

test("strict types: shared fresh row preserves the outer lexical level", () => {
  const first = freshRow(["x"], 2);
  const second = freshRow(["y"], 0);
  const left = record(row(new Map([["x", number]]), first));
  const right = record(row(new Map([["y", boolean]]), second));
  accept(unify(left, right));
  assert.equal(flatten(first.instance!).tail?.level, 0);
  assert.equal(flatten(second.instance!).tail?.level, 0);
});

for (const expected of [number, fn(number, number)]) {
  test(`strict types: row unification checks newly exposed common fields (${show(expected)})`, () => {
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

test("strict types: equal newly exposed fields still unify", () => {
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

test("strict types: row and ordinary occurs checks cross record fields", () => {
  const a = fresh();
  reject(unify(a, field("x", a)), /Infinite type/);
  const tail = freshRow();
  const type = record(row(new Map(), tail));
  reject(unify(type, field("self", type)), /Infinite row/);
});

test("strict types: rigid witnesses allocate per execution of reusable subsumption", () => {
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

const applied = (head: Type, arg: Type): Type => {
  const result = run(apply(head, arg));
  assert.ok(result.success, result.success ? "" : result.errors[0].message);
  return result.value;
};

const unaryKind = () => kindArrow(typeKind, typeKind);

test("strict kinds: arrows, occurs checks, and kind mismatches", () => {
  const kind = freshKind();
  accept(unifyKinds(kind, unaryKind()));
  assert.equal(showKind(kind), "(Type -> Type)");
  reject(unifyKinds(typeKind, kind), /Kind mismatch/);
  const cyclic = freshKind();
  reject(unifyKinds(cyclic, kindArrow(cyclic, typeKind)), /Infinite kind/);
  const indirect = freshKind();
  const tail = freshKind();
  accept(unifyKinds(indirect, kindArrow(tail, typeKind)));
  reject(unifyKinds(tail, indirect), /Infinite kind/);
});

test("strict kinds: source application errors use Check, not exceptions", () => {
  reject(apply(number, boolean), /Kind mismatch/);
  reject(apply(constructorType(option), constructorType(option)), /Kind mismatch/);
  const first = applied(constructorType(option), number);
  reject(apply(first, boolean), /Kind mismatch/);
  assert.equal(showKind(kindOf(constructorType(option))), "(Type -> Type)");
  assert.equal(showKind(kindOf(first)), "Type");
  assert.deepEqual(decompose(first).args, [number]);
  assert.equal(decompose(first).head.kind, "constructor");
});

test("strict kinds: inferred constructor parameter kinds can be higher kinded", () => {
  const higher: TypeConstructor = {
    id: Symbol("Fix"),
    name: "Fix",
    arity: 1,
    parameters: [unaryKind()],
  };
  const fixed = applied(constructorType(higher), constructorType(option));
  assert.equal(show(fixed), "Fix(Option)");
  reject(apply(constructorType(higher), number), /Kind mismatch/);
});

test("strict types: f a unifies with Option number without higher-order search", () => {
  const f = fresh(0, freshKind());
  const a = fresh();
  const fa = applied(f, a);
  accept(unify(fa, data(option, [number])));
  assert.ok(sameType(f, constructorType(option)));
  assert.equal(prune(a), number);
  assert.equal(showKind(kindOf(f)), "(Type -> Type)");
  reject(unify(fresh(), constructorType(option)), /Kind mismatch/);
});

test("strict types: application occurs checks include heads and arguments", () => {
  const a = fresh();
  reject(unify(a, applied(constructorType(option), a)), /Infinite type/);
  const f = fresh(0, unaryKind());
  const higher: TypeConstructor = {
    id: Symbol("Compose"),
    name: "Compose",
    arity: 2,
    parameters: [unaryKind(), typeKind],
  };
  reject(unify(f, applied(constructorType(higher), f)), /Infinite type/);
});

test("strict constraints: predicates and result share fresh type variables", () => {
  const a = fresh();
  const type = qualified([{ className: "Eq", arg: a }], fn(a, boolean));
  const scheme = generalize(type, []);
  const first = instantiate(scheme);
  const second = instantiate(scheme);
  assert.ok(first.kind === "qualified" && first.type.kind === "function");
  assert.ok(second.kind === "qualified" && second.type.kind === "function");
  assert.equal(first.predicates[0]!.arg, first.type.param);
  assert.equal(second.predicates[0]!.arg, second.type.param);
  assert.notEqual(first.predicates[0]!.arg, second.predicates[0]!.arg);
  accept(unify(first.type.param, number));
  accept(unify(second.type.param, boolean));
  assert.equal(show(first), "(Eq number => (number -> boolean))");
  assert.equal(show(type), "(Eq a => (a -> boolean))");
  assert.equal(qualified([], number), number);
});

test("strict constraints: higher-kinded predicates and applications freshen together", () => {
  const f = generic("f", unaryKind());
  const a = generic("a");
  const fa = applied(f, a);
  const type = forall([f, a], qualified([{ className: "Functor", arg: f }], fn(fa, fa)));
  const first = instantiateForall(type);
  const second = instantiateForall(type);
  assert.ok(first.kind === "qualified" && first.type.kind === "function");
  assert.ok(second.kind === "qualified" && second.type.kind === "function");
  accept(unify(first.type.param, data(option, [number])));
  assert.ok(sameType(first.predicates[0]!.arg, constructorType(option)));
  assert.equal(show(first.type.result), "Option(number)");
  assert.equal(prune(second.predicates[0]!.arg).kind, "variable");
  assert.equal(free(type).size, 0);
});

test("strict constraints: all predicate-only metas participate in generalization", () => {
  const a = fresh();
  const type = qualified([{ className: "Ambiguous", arg: a }], number);
  assert.ok(free(type).has(a));
  assert.ok(generalize(type, []).variables.has(a));
  assert.equal(generalize(type, [mono(a)]).variables.size, 0);
  reject(unify(type, number), /dictionary/);
  reject(subsume(type, number), /dictionary/);
  reject(subsume(number, type), /dictionary/);
});

test("strict constraints: rigid skolems in predicates cannot escape through nested structures", () => {
  const a = generic("a");
  const value = skolemize(forall([a], qualified([{ className: "C", arg: a }], number)), 2);
  assert.ok(value.kind === "qualified");
  assert.equal(value.predicates[0]!.arg.kind, "skolem");
  reject(unify(fresh(0), fn(value, number)), /Skolem escape/);
  const tail = freshRow([], 0);
  reject(unify(record(row(new Map(), tail)), field("method", fn(value, number))), /Skolem escape/);
});

test("strict types: skolem escapes and lowering traverse higher-kinded application heads", () => {
  const f = generic("f", unaryKind());
  const rigid = skolemize(forall([f], f), 2);
  reject(unify(fresh(0, unaryKind()), rigid), /Skolem escape/);
  reject(unify(fresh(0), applied(rigid, number)), /Skolem escape/);
  const inner = fresh(3, unaryKind());
  accept(unify(fresh(0), applied(inner, number)));
  assert.equal(inner.level, 0);
  reject(unify(inner, rigid), /Skolem escape/);
});

test("strict kinds: forall kind templates are copied, not specialized by their first use", () => {
  const a = generic("a", freshKind());
  const type = forall([a], a);
  const first = instantiateForall(type);
  const second = instantiateForall(type);
  accept(unify(first, constructorType(option)));
  accept(unify(second, number));
  assert.equal(pruneKind(a.typeKind).kind, "kind-variable");
  assert.equal(showKind(kindOf(first)), "(Type -> Type)");
  assert.equal(showKind(kindOf(second)), "Type");
});

test("strict kinds: generalized metas copy shared kind graphs within each instance", () => {
  const k = freshKind();
  const f = fresh(0, kindArrow(k, typeKind));
  const a = fresh(0, k);
  const original = applied(f, a);
  const scheme = generalize(original, []);
  const first = instantiate(scheme);
  const second = instantiate(scheme);
  accept(unify(first, data(option, [number])));
  const higher: TypeConstructor = {
    id: Symbol("Fix"),
    name: "Fix",
    arity: 1,
    parameters: [unaryKind()],
  };
  accept(unify(second, data(higher, [constructorType(option)])));
  assert.equal(pruneKind(k).kind, "kind-variable");
});

test("strict kinds: kind links to unquantified outer metas are not cloned away", () => {
  const k = freshKind();
  const outer = fresh(0, k);
  const inner = fresh(0, kindArrow(k, typeKind));
  const original = applied(inner, outer);
  const instance = instantiate(generalize(original, [mono(outer)]));
  accept(unify(instance, data(option, [number])));
  assert.equal(prune(outer), number);
  assert.equal(pruneKind(k), typeKind);
});

test("strict kinds: nested forall retains the outer application's kind relationships", () => {
  const k = freshKind();
  const f = generic("f", kindArrow(k, typeKind));
  const a = generic("a", k);
  const original = forall([f], fn(forall([a], applied(f, a)), number));
  const instance = instantiateForall(original);
  assert.ok(instance.kind === "function" && instance.param.kind === "forall");
  const nested = instantiateForall(instance.param);
  assert.ok(nested.kind === "application");
  accept(unify(nested.fn, constructorType(option)));
  assert.equal(showKind(kindOf(nested.arg)), "Type");
  assert.equal(pruneKind(k).kind, "kind-variable");
});

test("strict sameType is non-solving and respects nominal and rigid identities", () => {
  const a = fresh();
  const b = fresh();
  assert.equal(sameType(a, b), false);
  assert.equal(sameType(a, number), false);
  assert.equal(a.instance, undefined);
  assert.equal(b.instance, undefined);
  assert.ok(sameType(data(option, [number]), data(option, [number])));
  assert.equal(
    sameType(data(option, [number]), data({ ...option, id: Symbol("Option") }, [number])),
    false,
  );
  const rigid = skolemize(forall([generic("a")], number), 1);
  assert.ok(sameType(rigid, number));
  const g = generic("a");
  const one = skolemize(forall([g], g), 1);
  const two = skolemize(forall([g], g), 1);
  assert.equal(sameType(one, two), false);
  assert.equal(sameType(generic("a"), generic("a")), false);
  const tail = freshRow();
  assert.ok(
    sameType(record(row(new Map([["x", a]]), tail)), record(row(new Map([["x", a]]), tail))),
  );
  assert.equal(sameType(record(row(new Map(), tail)), record(row(new Map(), freshRow()))), false);
  // Even existing indirection chains are not path-compressed by equality.
  const end = fresh();
  const middle = fresh();
  const start = fresh();
  middle.instance = end;
  start.instance = middle;
  assert.ok(sameType(start, end));
  assert.equal(start.instance, middle);
});

test("strict kinds: defaulting fixes only remaining unknown leaves", () => {
  const left = freshKind();
  const right = freshKind();
  const kind = kindArrow(left, kindArrow(right, typeKind));
  accept(defaultKind(kind));
  assert.equal(showKind(kind), "(Type -> (Type -> Type))");
  assert.equal(pruneKind(left), typeKind);
  assert.equal(pruneKind(right), typeKind);
  reject(unifyKinds(left, unaryKind()), /Kind mismatch/);
});

test("strict substitution alpha-renames binders that would capture a replacement", () => {
  const a = generic("a");
  const b = generic("b");
  const result = substitute(forall([b], fn(a, b)), new Map([[a, b]]));
  assert.ok(result.kind === "forall" && result.body.kind === "function");
  assert.equal(result.body.param, b);
  assert.notEqual(result.variables[0], b);
  assert.equal(result.body.result, result.variables[0]);
});
