import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { compile as rawCompile, show } from "../examples/strict/strict.ts";
import { validate } from "langkit/ir";

const read = (uri: string): string => readFileSync(new URL(uri), "utf8");
const options = { uri: new URL("../input.strict", import.meta.url).href, read };

const compile = (source: string) =>
  rawCompile(`import "./examples/strict/stdlib.strict";\n${source}`, options);

const build = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  validate(result.value.ir);
  return result.value;
};

const evaluate = (source: string) =>
  runInNewContext(build(source).javascript, {}, { timeout: 1000 });

const select = `class Select a where { select : a -> a; }
instance Select number where { select x = x + 1; }
instance Select boolean where { select x = x; }`;

for (const [source, expected] of [
  [
    `${select} choose : forall a. Select a => a -> a; rec choose x = if true then select x else choose x; main = if choose true then choose 41 else 0;`,
    42,
  ],
  [
    `${select} outer x = let inner ignored = select x in inner {}; main = if outer true then outer 41 else 0;`,
    42,
  ],
  [
    `${select} outer x = let inner y = { x = select x, y = select y } in inner true; main = (outer 41).x;`,
    42,
  ],
  [
    `${select} class Other a where { other : a -> a; } instance Other number where { other x = x + 1; } twice : forall a. (Select a, Other a) => a -> a; twice x = other (select x); main = twice 40;`,
    42,
  ],
  [
    `${select} class Other a where { other : a -> a; } instance Other number where { other x = x + 1; } twice x = other (select x); main = twice 40;`,
    42,
  ],
  [
    "class Empty (f : Type -> Type) where { empty : forall a. f a; } instance Empty Option where { empty = None; } main = withDefault 42 empty;",
    42,
  ],
  ["data Box a = Box a; main = case Box 42 of { Box x -> x; };", 42],
  ["x = 1; x == 1", true],
  ["f x = x; x = 1; y = 1; f x == y", true],
] as const) {
  test(`strict dictionary regression: ${source}`, () => assert.equal(evaluate(source), expected));
}

for (const source of [
  `${select} bad : forall a b. Select a => b -> b; bad x = x; main = 0;`,
  `${select} rec choose x = if true then select x else choose x; main = choose 41;`,
  "data Proxy a = Proxy; main : Proxy Option; main = Proxy;",
  "data Apply f a = Apply (f a); bad : Apply number number; bad = Apply 42; main = 0;",
  "class Broken a where { broken : number -> number; } main = 0;",
  "keep : forall f a. f a -> f a; keep xs = map id xs; main = 0;",
  "main : (Functor Option => number) -> number; main x = x;",
  "f x = (map : forall f a b. Functor f => (a -> b) -> f a -> f b); main = f;",
  "f x = (map : forall f a b. Functor f => (a -> b) -> f a -> f b); main = withDefault 0 (f {} id (Some 42));",
]) {
  test(`strict rejects invalid abstraction: ${source}`, () =>
    assert.equal(compile(source).success, false));
}

test("strict effects are repeatable actions, not memoized lazy values", () => {
  const built = build("main = let action = print 42 in do { action; action; pure 7; };");
  assert.match(show(built.type), /Effect/);
  const output: unknown[] = [];
  const context = {
    console: {
      log: (value: unknown) => {
        output.push(value);
      },
    },
  };
  assert.equal(runInNewContext(`(${built.javascript})({})`, context, { timeout: 1000 }), 7);
  assert.deepEqual(output, [42, 42]);
});

test("strict Functor Effect preserves delayed evaluation and result typing", () => {
  const source = `instance Functor Effect where { map f action = bind action (\\x -> pure (f x)); }
main : Effect number; main = map (\\x -> x + 1) (pure 41);`;
  const built = build(source);
  assert.equal(runInNewContext(`(${built.javascript})({})`, {}, { timeout: 1000 }), 42);
});
