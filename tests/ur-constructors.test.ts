import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { analyze, compile, show } from "../examples/ur/ur.ts";

const evaluate = (source: string): { value: unknown; type: string } => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  const value: unknown = runInNewContext(result.value.javascript, {}, { timeout: 1000 });
  assert.deepEqual(analyze(source).diagnostics, []);
  return { value: JSON.parse(JSON.stringify(value)), type: show(result.value.type) };
};

const definitions = `
  type Identity<A> = A;
  type Box<A> = { value: A };
  type Metadata<A> = { label: string, show: A -> string };
  type Compose<F: Type -> Type, G: Type -> Type, A> = F<G<A>>;
`;

for (const [name, source, expected] of [
  [
    "transparent aliases and structural inference",
    `
    type Box<A> = { value: A };
    fn unbox<A>(box: Box<A>) -> A = box.value;
    let main = unbox({ value: true });
  `,
    true,
  ],
  [
    "explicit higher-kinded application",
    `
    ${definitions}
    fn keep<F: Type -> Type, A>(value: F<A>) -> F<A> = value;
    let main = keep<Box, number>({ value: 42 });
  `,
    { value: 42 },
  ],
  [
    "higher-kinded rigid function bodies",
    `
    ${definitions}
    fn keep<F: Type -> Type, A>(value: F<A>) -> F<A> = value;
    fn forward<F: Type -> Type, A>(value: F<A>) -> F<A> = keep<F, A>(value);
    let main = forward<Box, boolean>({ value: true });
  `,
    { value: true },
  ],
  [
    "partial application and beta reduction",
    `
    ${definitions}
    type DoubleBox<A> = Compose<Box, Box, A>;
    fn keep<F: Type -> Type, A>(value: F<A>) -> F<A> = value;
    let main = keep<Compose<Box, Box>, number>({ value: { value: 42 } });
  `,
    { value: { value: 42 } },
  ],
  [
    "higher-order constructor argument and eta reduction",
    `
    ${definitions}
    type Apply<F: Type -> Type, A> = F<A>;
    fn keep<F: Type -> Type, A>(value: F<A>) -> F<A> = value;
    let main = keep<Apply<Box>, string>({ value: "ok" });
  `,
    { value: "ok" },
  ],
  [
    "constant constructors are legal but not injective",
    `
    type Ignore<A> = number;
    fn keep<F: Type -> Type, A>(value: F<A>) -> F<A> = value;
    let main = keep<Ignore, boolean>(42);
  `,
    42,
  ],
  [
    "a type alias cannot capture a later generic with the same spelling",
    `
    type Box<A> = { value: A };
    type Pair<A, B> = { first: A, second: B };
    fn pair<A>(value: A) -> Pair<A, Box<number>> = { first: value, second: { value: 42 } };
    let main = pair(true);
  `,
    { first: true, second: { value: 42 } },
  ],
  [
    "explicit arguments for an otherwise uninferrable row split",
    `
    fn split<A: Row<Type>, B: Row<Type>>(value: Record<A ++ B>) -> Record<B ++ A>
    where disjoint(A, B) = value;
    let main = split<{x: number}, {y: boolean}>({x: 42, y: true});
  `,
    { x: 42, y: true },
  ],
  [
    "closed row map checks heterogeneous metadata",
    `
    ${definitions}
    let meta: Record<Map<Metadata, {count: number, ready: boolean}>> = {
      count: { label: "Count", show: fn(value: number) => if value > 0 then "positive" else "zero" },
      ready: { label: "Ready", show: fn(value: boolean) => if value then "yes" else "no" }
    };
    let main = { count: meta.count.show(2), ready: meta.ready.show(false) };
  `,
    { count: "positive", ready: "no" },
  ],
  [
    "row aliases and mapper result reduction",
    `
    ${definitions}
    type Fields: Row<Type> = {x: number, y: boolean};
    type Boxed<R: Row<Type>>: Row<Type> = Map<Box, R>;
    let main: Record<Boxed<Fields>> = {x: {value: 42}, y: {value: true}};
  `,
    { x: { value: 42 }, y: { value: true } },
  ],
  [
    "identity map over a rigid abstract row",
    `
    ${definitions}
    fn identityRow<R: Row<Type>>(value: Record<Map<Identity, R>>) -> Record<R> = value;
    let main = identityRow({x: 42, y: true});
  `,
    { x: 42, y: true },
  ],
  [
    "map distributes over abstract row concatenation",
    `
    ${definitions}
    fn distribute<F: Type -> Type, A: Row<Type>, B: Row<Type>>(
      left: Record<Map<F, A>>, right: Record<Map<F, B>>
    ) -> Record<Map<F, A ++ B>> where disjoint(A, B) = left ++ right;
    let main = distribute<Box, {x: number}, {y: boolean}>({x: {value: 42}}, {y: {value: true}});
  `,
    { x: { value: 42 }, y: { value: true } },
  ],
  [
    "map fusion over a rigid abstract row and rigid constructors",
    `
    ${definitions}
    fn fuse<F: Type -> Type, G: Type -> Type, R: Row<Type>>(
      value: Record<Map<F, Map<G, R>>>
    ) -> Record<Map<Compose<F, G>, R>> = value;
    let main = fuse<Box, Box, {x: number}>({x: {value: {value: 42}}});
  `,
    { x: { value: { value: 42 } } },
  ],
  [
    "alpha-equivalent aliases produce equal abstract mappers",
    `
    type First<A> = {value: A};
    type Second<B> = {value: B};
    fn rename<R: Row<Type>>(value: Record<Map<First, R>>) -> Record<Map<Second, R>> = value;
    let main = rename<{answer: number}>({answer: {value: 42}});
  `,
    { answer: { value: 42 } },
  ],
  [
    "mapping a constant constructor never loses labels",
    `
    type Ignore<A> = number;
    let main: Record<Map<Ignore, {x: boolean, y: string}>> = {x: 1, y: 2};
  `,
    { x: 1, y: 2 },
  ],
  [
    "arbitrary-kind rows can carry type constructors",
    `
    ${definitions}
    type ApplyNumber<F: Type -> Type> = F<number>;
    type Constructors: Row<Type -> Type> = {plain: Identity, boxed: Box};
    let main: Record<Map<ApplyNumber, Constructors>> = {plain: 42, boxed: {value: 7}};
  `,
    { plain: 42, boxed: { value: 7 } },
  ],
  [
    "row-result constructors and explicit row arguments",
    `
    type Fields<A>: Row<Type> = {value: A};
    fn keep<F: Type -> Row<Type>, A>(value: Record<F<A>>) -> Record<F<A>> = value;
    let main = keep<Fields, boolean>({value: true});
  `,
    { value: true },
  ],
  [
    "abstract map fusion at higher row element kinds",
    `
    type ApplyNumber<F: Type -> Type> = F<number>;
    type Box<A> = {value: A};
    type Lift<F: (Type -> Type) -> Type, G: Type -> Type>: Type = G<F<Box>>;
    type ComposeHigh<F: Type -> Type, G: (Type -> Type) -> Type, H: Type -> Type> = F<G<H>>;
    fn fuse<F: Type -> Type, G: (Type -> Type) -> Type, R: Row<Type -> Type>>(
      value: Record<Map<F, Map<G, R>>>
    ) -> Record<Map<ComposeHigh<F, G>, R>> = value;
    let main = fuse<Box, ApplyNumber, {item: Box}>({item: {value: {value: 42}}});
  `,
    { item: { value: { value: 42 } } },
  ],
] as const) {
  test(`Ur constructors: ${name}`, () => {
    assert.deepEqual(evaluate(source).value, expected);
  });
}

test("Ur infers a mapped row from an earlier unmapped argument without inverting Map", () => {
  const source = `
    type Box<A> = {value: A};
    fn metadata<R: Row<Type>>(raw: Record<R>, meta: Record<Map<Box, R>>) -> Record<Map<Box, R>> = meta;
    let main = metadata({count: 42, ready: true}, {count: {value: 7}, ready: {value: false}});
  `;
  assert.deepEqual(evaluate(source).value, { count: { value: 7 }, ready: { value: false } });
  const invalid = compile(source.replace("ready: {value: false}", "ready: {value: 0}"));
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.match(invalid.errors.map(({ message }) => message).join("\n"), /Expected boolean, found number/);
});

for (const [name, source, error] of [
  [
    "wrong constructor kind",
    `type Box<A> = {value: A}; fn keep<F: Type -> Type, A>(x: F<A>) -> F<A> = x; let main = keep<number, boolean>(1);`,
    /Expected.*Type -> Type.*found Type/,
  ],
  [
    "higher kind used as runtime type",
    `fn bad<F: Type -> Type>(x: F) -> F = x; let main = 0;`,
    /Expected Type, found/,
  ],
  [
    "type passed as row",
    `type Box<A> = {value: A}; let main: Record<Box<number>> = {value: 1};`,
    /Expected Row/,
  ],
  [
    "row passed as type",
    `type Fields: Row<Type> = {x: number}; let main: Fields = {x: 1};`,
    /Expected Type.*Row/,
  ],
  [
    "wrong type application arity",
    `type Box<A> = {value: A}; let main: Box<number, boolean> = {value: 1};`,
    /Cannot apply/,
  ],
  [
    "missing type application argument",
    `type Box<A> = {value: A}; let main: Box = {value: 1};`,
    /Expected Type/,
  ],
  [
    "empty type application",
    `type Box<A> = {value: A}; let main: Box<> = {value: 1};`,
    /requires at least one/,
  ],
  ["recursive aliases", `type Loop<A> = Loop<A>; let main = 0;`, /recursive aliases/],
  ["forward alias cycle", `type A = B; type B = A; let main = 0;`, /earlier declarations/],
  ["duplicate alias", `type A = number; type A = boolean; let main = 0;`, /Duplicate/],
  ["reserved alias", `type number = boolean; let main = 0;`, /reserved/],
  ["duplicate constructor binder", `type Pair<A, A> = A; let main = 0;`, /Duplicate/],
  [
    "alias body checked even unused",
    `type Bad<F: Type -> Type> = F<number, boolean>; let main = 0;`,
    /Cannot apply/,
  ],
  [
    "ill-kinded Map mapper",
    `let main: Record<Map<number, {x: number}>> = {x: 42};`,
    /type-level function/,
  ],
  [
    "ill-kinded Map source",
    `${definitions} let main: Record<Map<Box, number>> = {};`,
    /Expected Row/,
  ],
  [
    "ill-kinded Map element",
    `type Apply<F: Type -> Type> = F<number>; let main: Record<Map<Apply, {x: number}>> = {};`,
    /Expected.*Type -> Type/,
  ],
  [
    "Map result must be a runtime Type row",
    `${definitions} type Lift<A>: Type -> Type = Box; let main: Record<Map<Lift, {x: number}>> = {};`,
    /Expected Row<Type>/,
  ],
  [
    "metadata formatter field mismatch",
    `${definitions} let main: Record<Map<Metadata, {x: boolean}>> = {x: {label: "x", show: fn(n: number) => "bad"}};`,
    /Expected/,
  ],
  [
    "Map does not erase missing fields",
    `${definitions} let main: Record<Map<Box, {x: number, y: boolean}>> = {x: {value: 1}};`,
    /Expected/,
  ],
  [
    "mapped row cannot overlap its source",
    `${definitions} fn bad<R: Row<Type>>(a: Record<R>, b: Record<Map<Box, R>>) -> {} = let unused = a ++ b in {}; let main = 0;`,
    /row with itself/,
  ],
  [
    "distinct mappers cannot make one row disjoint",
    `${definitions} fn bad<R: Row<Type>>(a: Record<Map<Box, R>>, b: Record<Map<Metadata, R>>) -> {} = let unused = a ++ b in {}; let main = 0;`,
    /row with itself/,
  ],
  [
    "mapped concrete collision",
    `${definitions} fn combine<A: Row<Type>, B: Row<Type>>(a: Record<Map<Box, A>>, b: Record<B>) -> Record<Map<Box, A> ++ B> where disjoint(A, B) = a ++ b; let main = combine<{x: number}, {x: boolean}>({x: {value: 1}}, {x: true});`,
    /Overlapping field/,
  ],
  [
    "higher-kinded generic is not secretly Box",
    `fn bad<F: Type -> Type, A>(x: F<A>) -> A = x.value; let main = 0;`,
    /Expected a record/,
  ],
  [
    "different applications are not equal",
    `fn bad<F: Type -> Type>(x: F<number>) -> F<boolean> = x; let main = 0;`,
    /Expected/,
  ],
  [
    "do not infer a constructor from a structural value",
    `${definitions} fn keep<F: Type -> Type, A>(x: F<A>) -> F<A> = x; let main = keep({value: 42});`,
    /Expected/,
  ],
  [
    "constant alias cannot infer discarded argument",
    `type Ignore<A> = number; fn bad<A>(value: Ignore<A>) -> number = value; let main = bad(42);`,
    /Cannot infer type parameter A/,
  ],
  [
    "constant application cannot determine other results",
    `type Ignore<A> = number; fn choose<F: Type -> Type, A>(x: F<A>, value: A) -> A = value; let main: number = choose<Ignore, boolean>(42, true);`,
    /Expected number, found boolean/,
  ],
  [
    "do not invert Map with a constant mapper",
    `type Ignore<A> = number; fn bad<R: Row<Type>>(x: Record<Map<Ignore, R>>) -> Record<R> = x; let main = 0;`,
    /Expected/,
  ],
  [
    "explicit generic arity",
    `fn id<A>(x: A) -> A = x; let main = id<number, boolean>(1);`,
    /Expected 1 type arguments/,
  ],
  [
    "explicit generic type enforced",
    `fn id<A>(x: A) -> A = x; let main = id<boolean>(1);`,
    /Expected boolean, found number/,
  ],
  [
    "constructor self application is ill-kinded",
    `type Bad<F: Type -> Type> = F<F>; let main = 0;`,
    /Expected Type, found/,
  ],
  [
    "alias cannot assume a row lacks fields",
    `type Bad<R: Row<Type>> = Record<R ++ {x: number}>; let main = 0;`,
    /Cannot prove disjoint/,
  ],
] as const) {
  test(`Ur constructors reject: ${name}`, () => {
    const result = compile(source);
    assert.equal(result.success, false, `Unexpected acceptance: ${source}`);
    if (!result.success) assert.match(result.errors.map(({ message }) => message).join("\n"), error);
  });
}

test("Ur row maps preserve label sets across every pair of three-field subsets", () => {
  const names = ["x", "y", "z"];
  let accepted = 0;
  let rejected = 0;
  for (let a = 0; a < 8; a++)
    for (let b = 0; b < 8; b++) {
      const entries = (mask: number) => names.filter((_, bit) => mask & (1 << bit));
      const rowType = (mask: number) =>
        `{${entries(mask)
          .map((name) => `${name}: number`)
          .join(",")}}`;
      const left = Object.fromEntries(
        entries(a).map((name, index) => [name, { value: index + 1 }]),
      );
      const right = Object.fromEntries(entries(b).map((name, index) => [name, index + 101]));
      const literal = (mask: number, boxed: boolean) =>
        `{${entries(mask)
          .map((name, index) => `${name}: ${boxed ? `{value: ${index + 1}}` : index + 101}`)
          .join(",")}}`;
      const source = `
      type Box<A> = {value: A};
      type Ignore<A> = number;
      fn combine<A: Row<Type>, B: Row<Type>>(
        a: Record<Map<Box, A>>, b: Record<Map<Ignore, B>>
      ) -> Record<Map<Box, A> ++ Map<Ignore, B>> where disjoint(A, B) = a ++ b;
      let main = combine<${rowType(a)}, ${rowType(b)}>(${literal(a, true)}, ${literal(b, false)});
    `;
      if (a & b) {
        const result = compile(source);
        assert.equal(result.success, false, source);
        if (!result.success) assert.match(result.errors.map(({ message }) => message).join("\n"), /Overlapping field/);
        rejected++;
      } else {
        assert.deepEqual(evaluate(source).value, { ...left, ...right });
        accepted++;
      }
    }
  assert.equal(accepted, 27);
  assert.equal(rejected, 37);
});

test("Ur disjointness over higher-kind rows survives maps to runtime field types", () => {
  const source = `
    type Box<A> = {value: A};
    type Identity<A> = A;
    type ApplyNumber<F: Type -> Type> = F<number>;
    fn combine<A: Row<Type -> Type>, B: Row<Type -> Type>>(
      a: Record<Map<ApplyNumber, A>>, b: Record<Map<ApplyNumber, B>>
    ) -> Record<Map<ApplyNumber, A ++ B>> where disjoint(A, B) = a ++ b;
    let main = combine<{a: Box}, {b: Identity}>({a: {value: 42}}, {b: 7});
  `;
  assert.deepEqual(evaluate(source).value, { a: { value: 42 }, b: 7 });
});

test("Ur Map fusion is associative and empty/identity maps normalize under rigid binders", () => {
  const source = `
    type Identity<A> = A;
    type Box<A> = {value: A};
    type Compose<F: Type -> Type, G: Type -> Type, A> = F<G<A>>;
    fn associate<F: Type -> Type, G: Type -> Type, H: Type -> Type, R: Row<Type>>(
      value: Record<Map<Compose<F, Compose<G, H>>, R>>
    ) -> Record<Map<Compose<Compose<F, G>, H>, R>> = value;
    fn empty<F: Type -> Type>(value: Record<Map<F, {}>>) -> {} = value;
    fn identities<R: Row<Type>>(value: Record<Map<Compose<Identity, Identity>, R>>) -> Record<R> = value;
    let main = {
      nested: associate<Box, Box, Box, {x: number}>({x: {value: {value: {value: 42}}}}),
      empty: empty<Box>({}),
      identity: identities({x: true})
    };
  `;
  assert.deepEqual(evaluate(source).value, {
    nested: { x: { value: { value: { value: 42 } } } },
    empty: {},
    identity: { x: true },
  });
});
