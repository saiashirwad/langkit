import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { validate } from "langkit/ir";
import { analyze, compile, show } from "../examples/ur/ur.ts";

const execute = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.error));
  validate(result.value.ir);
  const output: unknown[] = [];
  const value: unknown = runInNewContext(
    result.value.javascript,
    { console: { log: (value: unknown) => output.push(value) } },
    { timeout: 1000 },
  );
  assert.deepEqual(analyze(source).diagnostics, []);
  return { value, output, type: show(result.value.type) };
};

const definitions = `
  type Reading: Row<Type> = { count: number, active: boolean, name: string };
  type Formatter<A> = A -> string;
  fn field<A>(out: string, format: Formatter<A>, value: A) -> string =
    textConcat(out, format(value));
  fn render<R: Row<Type>>(
    order: Folder<R>, formats: Record<Map<Formatter, R>>, values: Record<R>
  ) -> string = foldRecord<Formatter, R, string>(order, formats, values, "", field);
  let values: Record<Reading> = { count: 42, active: true, name: "north" };
  let formats: Record<Map<Formatter, Reading>> = {
    count: fn(n: number) => if n > 20 then "high;" else "low;",
    active: fn(b: boolean) => if b then "yes;" else "no;",
    name: fn(s: string) => textConcat(s, ";")
  };
`;

for (const [name, source, expected] of [
  [
    "heterogeneous traversal through an abstract row helper",
    `${definitions} let main = render<Reading>(folder<Reading>(.name, .count, .active), formats, values);`,
    "north;high;yes;",
  ],
  [
    "folder order, not record literal order, controls traversal",
    `${definitions}
    let reordered = { name: values.name, active: values.active, count: values.count };
    let main = render<Reading>(folder<Reading>(.name, .count, .active), formats, reordered);`,
    "north;high;yes;",
  ],
  [
    "another permutation changes traversal",
    `${definitions} let main = render<Reading>(folder<Reading>(.active, .count, .name), formats, values);`,
    "yes;high;north;",
  ],
  [
    "folder and builtin aliases retain row and callback indices",
    `${definitions}
    fn keep<R: Row<Type>>(x: Folder<R>) -> Folder<R> = x;
    let fold = foldRecord;
    let order = keep(folder<Reading>(.count, .name, .active));
    let main = fold<Formatter, Reading, string>(order, formats, values, "", field);`,
    "high;north;yes;",
  ],
  [
    "empty folders return the initial accumulator without calling the step",
    `type F<A> = {};
    fn step<A>(out: number, meta: {}, x: A) -> number = let ignored = print("bad") in out + 1;
    let main = foldRecord<F, {}, number>(folder<{}>(), {}, {}, 42, step);`,
    42,
  ],
  [
    "generic callback alpha-equivalence",
    `fn identity<T>(x: T) -> T = x;
    fn use(f: forall<A>. A -> A) -> { n: number, b: boolean } = { n: f(42), b: f(true) };
    let main = use(identity);`,
    { n: 42, b: true },
  ],
  [
    "multi-argument polymorphic function annotations",
    `fn first<X>(x: X, y: X) -> X = x;
    fn use(f: forall<A>. (A, A) -> A) -> boolean = f(true, false);
    let main = use(first);`,
    true,
  ],
  [
    "explicit rank-2 aliases and annotations",
    `type Identity = forall<A>. A -> A;
    fn identity<T>(x: T) -> T = x;
    let id: Identity = identity;
    fn use(f: Identity) -> number = f(42);
    let main = use(id);`,
    42,
  ],
  [
    "kind-aware rank-2 higher-kinded callback",
    `type Box<A> = { value: A };
    fn keep<G: Type -> Type, B>(x: G<B>) -> G<B> = x;
    fn use(f: forall<F: Type -> Type, A>. F<A> -> F<A>) -> number =
      f<Box, number>({ value: 42 }).value;
    let main = use(keep);`,
    42,
  ],
  [
    "rank-2 callbacks retain opaque folder indices",
    `fn keep<S: Row<Type>>(x: Folder<S>) -> Folder<S> = x;
    fn use(f: forall<R: Row<Type>>. Folder<R> -> Folder<R>) -> Folder<{ x: number }> =
      f(folder<{ x: number }>(.x));
    let order = use(keep);
    type Ignore<A> = {};
    fn count<A>(n: number, meta: {}, value: A) -> number = n + 1;
    let main = foldRecord<Ignore, { x: number }, number>(order, { x: {} }, { x: 42 }, 0, count);`,
    1,
  ],
  [
    "forall substitution keeps captured outer type variables distinct",
    `type Callback<S> = forall<A>. (S, A) -> S;
    fn step<T>(s: string, x: T) -> string = s;
    fn use<S>(s: S, f: Callback<S>) -> S = f(s, true);
    let main = use("correct", step);`,
    "correct",
  ],
  [
    "returning a polymorphic callback preserves its binder",
    `fn identity<T>(x: T) -> T = x;
    fn get() -> forall<A>. A -> A = identity;
    let main = get()(42);`,
    42,
  ],
  [
    "rank-2 lambda parameters work without generic lambdas",
    `fn identity<T>(x: T) -> T = x;
    let use = fn(f: forall<A>. A -> A) => f(42);
    let main = use(identity);`,
    42,
  ],
  [
    "shadowed foldRecord and textConcat have ordinary lexical semantics",
    `let concat = textConcat;
    fn textConcat(x: number, y: number) -> number = x + y;
    fn foldRecord(x: number) -> number = x + 1;
    let main = { n: foldRecord(textConcat(20, 21)), text: concat("a", "b") };`,
    { n: 42, text: "ab" },
  ],
  [
    "local shadowing does not affect an already captured builtin",
    `let concat = textConcat;
    let main = let textConcat = fn(n: number) => n + 1 in concat("a", "b");`,
    "ab",
  ],
] as const) {
  test(`Ur folders: ${name}`, () => {
    const result = execute(source);
    assert.deepEqual(JSON.parse(JSON.stringify(result.value)), expected);
    assert.deepEqual(result.output, []);
  });
}

for (const [name, source, message] of [
  ["duplicate order", `let main = folder<{ x: number }>(.x, .x);`, /Duplicate folder field/],
  ["missing order", `let main = folder<{ x: number }>();`, /Missing folder fields/],
  ["extra order", `let main = folder<{ x: number }>(.x, .y);`, /Unknown folder field/],
  [
    "abstract construction",
    `fn bad<R: Row<Type>>() -> Folder<R> = folder<R>(); let main = 0;`,
    /closed row/,
  ],
  ["wrong folder kind", `let main = folder<number>();`, /Expected Row/],
  [
    "non-Type row",
    `type R: Row<Row<Type>> = { x: {} }; let main = folder<R>(.x);`,
    /Expected Row<Type>/,
  ],
  ["record forgery", `let main: Folder<{ x: number }> = { x: 42 };`, /Expected Folder/],
  [
    "index mismatch",
    `let main: Folder<{ x: boolean }> = folder<{ x: number }>(.x);`,
    /Expected Folder/,
  ],
  [
    "index laundering through a generic wrapper",
    `fn fake<A: Row<Type>, B: Row<Type>>(x: Folder<A>) -> Folder<B> = x; let main = 0;`,
    /Expected Folder/,
  ],
  [
    "same field names do not hide mismatched folder payload types",
    `${definitions} let main = render<Reading>(folder<{ count: string, active: boolean, name: string }>(.name, .count, .active), formats, values);`,
    /Expected number/,
  ],
  [
    "mismatched formatter",
    `${definitions} let main = render<Reading>(folder<Reading>(.name, .count, .active),
      { count: formats.active, active: formats.active, name: formats.name }, values);`,
    /Expected number/,
  ],
  [
    "missing metadata",
    `${definitions} let main = render<Reading>(folder<Reading>(.name, .count, .active),
      { count: formats.count, name: formats.name }, values);`,
    /Missing field/,
  ],
  [
    "extra metadata",
    `${definitions} let main = render<Reading>(folder<Reading>(.name, .count, .active),
      { count: formats.count, active: formats.active, name: formats.name, extra: true }, values);`,
    /rows do not match/,
  ],
  [
    "missing values",
    `${definitions} let main = render<Reading>(folder<Reading>(.name, .count, .active), formats,
      { count: 42, name: "north" });`,
    /Missing field/,
  ],
  [
    "monomorphic traversal step",
    `type F<A> = {};
    fn step(n: number, meta: {}, value: number) -> number = n + value;
    let main = foldRecord<F, { x: number }, number>(folder<{ x: number }>(.x), { x: {} }, { x: 42 }, 0, step);`,
    /Expected <A>/,
  ],
  [
    "wrong accumulator result",
    `type F<A> = {};
    fn step<A>(n: number, meta: {}, value: A) -> boolean = true;
    let main = foldRecord<F, {}, number>(folder<{}>(), {}, {}, 0, step);`,
    /Expected <A>/,
  ],
  [
    "wrong initial accumulator",
    `type F<A> = {};
    fn step<A>(n: number, meta: {}, value: A) -> number = n;
    let main = foldRecord<F, {}, number>(folder<{}>(), {}, {}, true, step);`,
    /Expected number/,
  ],
  [
    "callback metadata must use the same quantified field type",
    `type F<A> = A -> string;
    fn step<A>(s: string, f: number -> string, a: A) -> string = s;
    let main = foldRecord<F, {}, string>(folder<{}>(), {}, {}, "", step);`,
    /Expected <A>/,
  ],
  [
    "unused invalid generic callback body",
    `fn step<A>(n: number, meta: {}, value: A) -> number = n + value; let main = 0;`,
    /Expected number/,
  ],
  [
    "callback binder kinds differ",
    `fn id<R: Row<Type>>(x: Record<R>) -> Record<R> = x;
    fn use(f: forall<A>. A -> A) -> number = f(42);
    let main = use(id);`,
    /Expected <A>/,
  ],
  [
    "monomorphic function is not generalized to forall",
    `fn id(x: number) -> number = x;
    fn use(f: forall<A>. A -> A) -> boolean = f(true);
    let main = use(id);`,
    /Expected <A>/,
  ],
  [
    "rank-2 generic variable escape",
    `fn id<A>(x: A) -> A = x;
    fn escape<T>(f: forall<A>. A -> T) -> T = f(true);
    let main = escape(id);`,
    /Cannot infer/,
  ],
  [
    "explicit type does not permit binder escape",
    `fn id<A>(x: A) -> A = x;
    fn escape<T>(f: forall<A>. A -> T) -> T = f(true);
    let main = escape<number>(id);`,
    /Expected <A>/,
  ],
  [
    "ordinary impredicative inference remains rejected",
    `fn id<A>(x: A) -> A = x; fn keep<T>(x: T) -> T = x; let main = keep(id);`,
    /Polymorphic values/,
  ],
  [
    "explicit impredicative argument remains rejected",
    `fn id<A>(x: A) -> A = x; fn keep<T>(x: T) -> T = x;
    let main = keep<forall<A>. A -> A>(id);`,
    /Polymorphic types/,
  ],
  ["empty forall", `let main: forall<>. number -> number = fn(n: number) => n;`, /at least one/],
  ["nonfunction forall", `type Bad = forall<A>. A; let main = 0;`, /function type/],
  ["duplicate forall binder", `type Bad = forall<A, A>. A -> A; let main = 0;`, /Duplicate/],
  ["function tuple without arrow", `type Bad = (number, boolean); let main = 0;`, /function arrow/],
  ["textConcat types", `let main = textConcat(1, "a");`, /Expected string/],
] as const) {
  test(`Ur folders reject ${name}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
    assert.equal(analyze(source).diagnostics.length, 1);
  });
}

test("Ur folder arguments and steps execute once in order", () => {
  const result = execute(`
    type R: Row<Type> = { x: number, y: boolean };
    type F<A> = string;
    fn step<A>(acc: string, label: string, value: A) -> string =
      let ignored = print(label) in textConcat(acc, label);
    fn choose(f: forall<T>. (string, string, T) -> string)
      -> forall<U>. (string, string, U) -> string =
      let ignored = print("step") in f;
    let main = foldRecord<F, R, string>(
      let ignored = print("order") in folder<R>(.y, .x),
      let ignored = print("metadata") in { x: "X", y: "Y" },
      let ignored = print("values") in { x: 42, y: true },
      let ignored = print("initial") in "",
      choose(step)
    );
  `);
  assert.equal(result.value, "YX");
  assert.deepEqual(result.output, ["order", "metadata", "values", "initial", "step", "Y", "X"]);
});

test("Ur folder checking and analysis never execute arguments or callbacks", () => {
  const source = `
    type F<A> = {};
    fn step<A>(acc: number, meta: {}, value: A) -> number =
      let ignored = print("step") in acc + 1;
    let ignored = print("initializer");
    fn main() {
      print(foldRecord<F, { x: boolean }, number>(folder<{ x: boolean }>(.x), { x: {} }, { x: true }, 0, step));
    }
  `;
  const before: unknown[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => before.push(args);
  try {
    assert.equal(compile(source).success, true);
    assert.deepEqual(analyze(source).diagnostics, []);
  } finally {
    console.log = original;
  }
  assert.deepEqual(before, []);
  assert.deepEqual(execute(source).output, ["initializer", "step", 1]);
});

test("Ur folders support unusual record keys without prototype lookup", () => {
  const result = execute(`
    type R: Row<Type> = { __proto__: number, constructor: boolean };
    type F<A> = {};
    fn step<A>(n: number, meta: {}, value: A) -> number = n + 1;
    let main = foldRecord<F, R, number>(folder<R>(.constructor, .__proto__),
      { __proto__: {}, constructor: {} }, { __proto__: 42, constructor: true }, 0, step);
  `);
  assert.equal(result.value, 2);
});

test("Ur folder example prints the heterogeneous report from the actual CLI", () => {
  const source = readFileSync(new URL("../examples/ur/folders.ur", import.meta.url), "utf8");
  assert.deepEqual(execute(source).output, ["Station: north; Temperature: warm; Active: yes; "]);
  const result = spawnSync(process.execPath, ["examples/ur/ur-run.ts", "examples/ur/folders.ur"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Station: north; Temperature: warm; Active: yes; \n");
  assert.equal(result.stderr, "");
});
