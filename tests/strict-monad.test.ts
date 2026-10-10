import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { validate } from "langkit/ir";
import { typeAt } from "langkit/analysis";
import { analyze, compile as rawCompile, show } from "../examples/strict/strict.ts";

const withStdlib = (source: string) => `import "./examples/strict/stdlib.strict";\n${source}`;

const compile = (source: string) => rawCompile(withStdlib(source));

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : result.error.message);
  validate(result.value.ir);
  return result.value;
};

const evaluate = (source: string, output: unknown[] = []): unknown =>
  runInNewContext(
    compiled(source).javascript,
    { console: { log: (value: unknown) => output.push(value) } },
    { timeout: 1000 },
  );

const execute = (source: string, output: unknown[] = []): unknown =>
  runInNewContext(
    `(${compiled(source).javascript})({})`,
    { console: { log: (value: unknown) => output.push(value) } },
    { timeout: 1000 },
  );

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const some = (value: unknown) => ({ tag: "Option.Some", fields: [value] });
const none = { tag: "Option.None", fields: [] };

for (const [source, expected] of [
  ["main : Option number; main = do { x <- Some 20; y <- Some 22; pure (x + y); };", some(42)],
  ["main : Option number; main = do { x <- None; y <- Some 22; pure (x + y); };", none],
  ["main : Option number; main = do { x <- Some 20; y <- None; pure (x + y); };", none],
  ["main : Option number; main = do { Some 1; pure 42; };", some(42)],
  ["main : Option number; main = do { None; pure 42; };", none],
  ["main : Option number; main = do { pure 42; };", some(42)],
  ["main = do { Some 42; };", some(42)],
  ["main : Option number; main = pure 42;", some(42)],
  ["main : Option number; main = do { x <- Some 20; let y = x + 22; pure y; };", some(42)],
  [
    "main : Option number; main = let bind = \\x y -> None in do { x <- Some 41; pure (x + 1); };",
    some(42),
  ],
  [
    "main : Option number; main = do { x <- do { y <- Some 20; pure (y + 1); }; pure (x * 2); };",
    some(42),
  ],
] as const) {
  test(`monadic Option execution: ${source}`, () =>
    assert.deepEqual(plain(evaluate(source)), expected));
}

for (const tail of [
  "pure (loop {})",
  "let doomed = loop {}; pure doomed",
  "y <- loop {}; pure y",
]) {
  test(`None skips continuation construction: ${tail}`, () => {
    const source = `rec loop x = loop x; main : Option number; main = do { x <- None; ${tail}; };`;
    assert.deepEqual(plain(evaluate(source)), none);
  });
}

test("Some still evaluates ordinary expressions strictly", () => {
  const source =
    "rec loop x = loop x; main : Option number; main = do { x <- Some 1; pure (const 42 (loop {})); };";
  assert.throws(() => evaluate(source), /stack|timed out/i);
});

const helperBodies = [
  "lift f action = do { x <- action; pure (f x); };",
  "lift : forall m a b. Monad m => (a -> b) -> m a -> m b; lift f action = do { x <- action; pure (f x); };",
];
for (const helper of helperBodies) {
  test(`generic monadic helper independently specializes: ${helper}`, () => {
    const output: unknown[] = [];
    const source = `${helper}
      optional : Option number; optional = lift (\\x -> x + 1) (Some 41);
      main : Effect number; main = do { print optional; lift (\\x -> x + 2) (pure 40); };`;
    assert.equal(typeof evaluate(source, output), "function");
    assert.equal(output.length, 0);
    assert.equal(execute(source, output), 42);
    assert.deepEqual(plain(output), [some(42)]);
  });
}

test("generic aliases and local captures preserve Monad dictionaries", () => {
  const source = `lift f action = do { x <- action; pure (f x); };
    alias = lift;
    captured action = let finish ignored = do { x <- action; pure (x + 1); } in finish {};
    main : Option number; main = captured (alias (\\x -> x + 1) (Some 40));`;
  assert.deepEqual(plain(evaluate(source)), some(42));
});

test("inferred monadic helpers expose higher-kinded constraints in analysis", () => {
  const source = withStdlib(
    "lift f action = do { x <- action; pure (f x); }; main = lift id (Some 42);",
  );
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.match(show(typeAt(analysis, source.indexOf("lift"))!.type), /Monad/);
});

test("do matches explicit bind for Option", () => {
  const viaDo = "main : Option number; main = do { x <- Some 20; y <- Some 22; pure (x + y); };";
  const viaBind =
    "main : Option number; main = bind (Some 20) (\\x -> bind (Some 22) (\\y -> pure (x + y)));";
  assert.deepEqual(plain(evaluate(viaDo)), plain(evaluate(viaBind)));
});

test("user-defined Monad dictionary implements do without compiler cases", () => {
  const source = `data Identity a = Identity a;
    instance Monad Identity where {
      pure x = Identity x;
      bind action next = case action of { Identity x -> next x; };
    }
    main : Identity number;
    main = do { x <- Identity 20; y <- pure 22; pure (x + y); };`;
  assert.deepEqual(plain(evaluate(source)), { tag: "Identity.Identity", fields: [42] });
});

test("Effect dictionary delays and repeats each selected action in order", () => {
  const output: unknown[] = [];
  const source = `main : Effect number;
    main = let action = print "repeat" in do {
      print "first";
      x <- pure 40;
      action;
      action;
      let answer = x + 2;
      print answer;
      pure answer;
    };`;
  assert.equal(typeof evaluate(source, output), "function");
  assert.equal(output.length, 0);
  assert.deepEqual(analyze(withStdlib(source)).diagnostics, []);
  assert.equal(output.length, 0);
  assert.equal(execute(source, output), 42);
  assert.deepEqual(output, ["first", "repeat", "repeat", 42]);
});

test("Effect pure has an explicit context and does not execute a nested action", () => {
  const output: unknown[] = [];
  const source = "main : Effect (Effect {}); main = pure (print 42);";
  assert.equal(typeof execute(source, output), "function");
  assert.equal(output.length, 0);
  assert.equal(execute("main : Effect number; main = pure 42;"), 42);
});

for (const [source, message] of [
  ["main = pure 42;", /ambig|constrain|signature/i],
  ["main = do { pure 42; };", /ambig|constrain|signature/i],
  ["main : Option number; main = do { print 1; pure 42; };", /unify/i],
  ["main : Effect number; main = do { x <- Some 20; pure (x + 22); };", /unify/i],
  ["main = do { x <- Some 20; print x; };", /unify/i],
  ["data Box a = Box a; main = do { Box 42; };", /instance|Monad/i],
  ["data Box a = Box a; main = do { x <- Box 42; Box x; };", /instance|Monad/i],
  ["main : Option number; main = do { x <- Some 42; };", /last|final|action/i],
  ["main : Option number; main = do { let x = 42; };", /last|final|action/i],
  [
    "main : Option number; main = let action : Option number = do { x <- Some 42; pure x; } in pure x;",
    /Unbound variable/,
  ],
  [
    "data Identity a = Identity a; instance Monad Identity where { pure x = Identity x; } main = 0;",
    /Missing.*bind/i,
  ],
  [
    "data Identity a = Identity a; instance Monad Identity where { pure x = Identity true; bind action next = case action of { Identity x -> next x; }; } main = 0;",
    /unify|skolem|rigid/i,
  ],
  [
    "instance Monad Option where { pure x = Some x; bind action next = None; } main = 0;",
    /duplicate|overlap/i,
  ],
] as const) {
  test(`monadic do rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, message);
  });
}
