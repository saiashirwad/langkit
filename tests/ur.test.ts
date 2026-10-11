import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile, show } from "../examples/ur/ur.ts";

const merge = `fn merge<A: Row<Type>, B: Row<Type>>(left: Record<A>, right: Record<B>)
  -> Record<A ++ B> where disjoint(A, B) = left ++ right;`;
const identity = "fn identity<A>(value: A) -> A = value;";

const compiled = (source: string) => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  return result.value;
};

const execute = (source: string) => {
  const output: unknown[] = [];
  const value: unknown = runInNewContext(
    compiled(source).javascript,
    {
      console: { log: (value: unknown) => output.push(value) },
    },
    { timeout: 1000 },
  );
  return { output, value };
};

const evaluate = (source: string): unknown =>
  runInNewContext(compiled(source).javascript, {}, { timeout: 1000 });

for (const [source, expected] of [
  ["let main = 12 - 3 - 2;", 7],
  ["let main = 2 + 3 * 4;", 14],
  ["let main = -2 * 3;", -6],
  ["let main = if 4 > 2 then 42 else 0;", 42],
  ['let main = if "a" == "a" then 42 else 0;', 42],
  ["let main = if true == false then 0 else 42;", 42],
  [`${identity} let main = if identity(true) then identity(42) else 0;`, 42],
  [`${identity} let alias = identity; let main = alias(42);`, 42],
  [`${identity} let main = identity({ answer: 42 }).answer;`, 42],
  ["fn id<A: Type>(value: A) -> A = value; let main = id(42);", 42],
  [
    'fn greet(person: { name: string }) -> string = person.name; let main = greet({ name: "Ada" });',
    "Ada",
  ],
  [`${merge} let main = merge({ name: "Ada" }, { age: 37 }).age;`, 37],
  [`${merge} let main = merge({}, { answer: 42 }).answer;`, 42],
  [`${merge} let main = merge({ answer: 42 }, {}).answer;`, 42],
  ["let main = ({ a: 20 } ++ { b: 22 }).a + ({ a: 20 } ++ { b: 22 }).b;", 42],
  ["let main = ({ a: 20 }++{ b: 22 }).b;", 22],
  ["fn id<R: Row<Type>>(value: Record<R>) -> Record<R> = value; let main = id({ x: 42 }).x;", 42],
  [
    "fn get<R: Row<Type>>(value: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = value.x; let main = get({ y: true, x: 42 });",
    42,
  ],
  [
    `${merge} fn extend<R: Row<Type>>(value: Record<R>) -> Record<R ++ { x: number }> where disjoint(R, { x: number }) = merge(value, { x: 42 }); let main = extend({ y: true }).x;`,
    42,
  ],
  [
    `${merge} fn swap<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> Record<B ++ A> where disjoint(A, B) = merge(b, a); let main = swap({ x: 42 }, { y: false }).x;`,
    42,
  ],
  [
    `${merge} fn three<A: Row<Type>, B: Row<Type>, C: Row<Type>>(a: Record<A>, b: Record<B>, c: Record<C>) -> Record<A ++ B ++ C> where disjoint(A, B), disjoint(A ++ B, C) = merge(merge(a, b), c); let main = three({ x: 1 }, { y: 42 }, { z: 3 }).y;`,
    42,
  ],
  [
    "fn makeAdder(amount: number) -> number -> number = fn(value: number) => value + amount; let plus20 = makeAdder(20); let main = plus20(22);",
    42,
  ],
  ["let x = 20; fn add(y: number) -> number = x + y; let main = let x = 100 in add(22);", 42],
  ["let x = 20; let main = (fn(x: number) => fn(y: number) => x + y)(40)(2);", 42],
  ["fn answer() -> number = 42; let main = answer();", 42],
  ["fn add(a: number, b: number) -> number = a + b; let main = add(20, 22);", 42],
  [
    "fn apply(f: number -> number, x: number) -> number = f(x); let main = apply(fn(n: number) => n + 1, 41);",
    42,
  ],
  ["let main: { a: number, b: boolean } = { b: true, a: 42 }; let answer = main.a;", undefined],
  [
    "fn same<A>(x: A, y: A) -> A = x; let main = same({ x: 42, y: true }, { y: false, x: 1 }).x;",
    42,
  ],
  ["let main = { __proto__: 42 }.__proto__;", 42],
  [`${merge} let main = merge({ __proto__: 42 }, { constructor: true }).__proto__;`, 42],
] as const) {
  test(`Ur execution: ${source}`, () => {
    const result = evaluate(source);
    if (expected !== undefined) assert.equal(result, expected);
    else assert.equal((result as { a: number }).a, 42);
  });
}

for (const [source, message] of [
  ["let main = unknown;", /Unknown value/],
  ["let main: number = true;", /Expected number/],
  ["let main = 1(true);", /Expected a function/],
  ["let main = 1 + true;", /Expected number/],
  ["let main = true > false;", /Expected number/],
  ["let main = 1 == true;", /Expected number/],
  ["let main = {} == {};", /Equality.*primitive/],
  ["let main = if 1 then 2 else 3;", /Expected boolean/],
  ["let main = if true then 2 else false;", /Expected number/],
  ["let main = { x: 1, x: 2 };", /Duplicate field/],
  ["let main: { x: number, x: boolean } = { x: 1 };", /Duplicate field/],
  ["let main = { x: 1 }.y;", /Unknown field/],
  ["let main = 1.x;", /Expected a record/],
  ["let x = 1; let x = 2; let main = x;", /Duplicate declaration/],
  ["fn x(a: number) -> number = a; let x = 1; let main = x;", /Duplicate declaration/],
  ["fn f(a: number, a: number) -> number = a; let main = 0;", /Duplicate parameter/],
  ["fn f<A, A>(a: A) -> A = a; let main = 0;", /Duplicate.*type parameter/],
  ["fn f<number>(a: number) -> number = a; let main = 0;", /reserved type parameter/],
  ["fn f(a: Missing) -> number = 1; let main = 0;", /Unknown type/],
  ["fn bad<A>(x: A) -> A = 1; let main = 0;", /Expected A/],
  ["fn bad<A>(x: A) -> number = x; let main = 0;", /Expected number/],
  ["fn bad<A>(x: A) -> number = x + 1; let main = 0;", /Expected number/],
  ["fn bad<A, B>(x: A) -> B = x; let main = 0;", /Expected B/],
  [`${identity} fn bad<A>(x: A) -> number = identity(x); let main = 0;`, /Expected number/],
  ["fn same<A>(x: A, y: A) -> A = x; let main = same(1, true);", /Expected number/],
  ["fn f(x: number) -> boolean = x; let main = 0;", /Expected boolean/],
  ["fn f(x: number) -> number = x; let main = f();", /Expected 1 arguments/],
  ["fn f(x: number) -> number = x; let main = f(1, 2);", /Expected 1 arguments/],
  ["fn f(a: number, b: number) -> number = a; let main = f(1);", /Expected 2 arguments/],
  ["let main = (fn(x: number) => x)(true);", /Expected number/],
  ["fn bad<R: Row<Type>>(x: R) -> number = 0; let main = 0;", /Expected Type.*Row/],
  ["fn bad<A>(x: Record<A>) -> number = 0; let main = 0;", /Expected Row.*Type/],
  ["fn bad<R: Row<Type>>(x: Record<R>) -> number = x.answer; let main = 0;", /Unknown field/],
  ["let main = { x: 1 } ++ { x: 2 };", /Overlapping field/],
  ["let main = {} ++ 1;", /requires two records/],
  [`${merge} let main = merge({ x: 1 }, { x: true });`, /Overlapping field/],
  [`${merge} let alias = merge; let main = alias({ x: 1 }, { x: 2 });`, /Overlapping field/],
  [
    "fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> Record<A ++ B> = a ++ b; let main = 0;",
    /Cannot prove disjoint/,
  ],
  [
    "fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = a ++ b in {}; let main = 0;",
    /Cannot prove disjoint/,
  ],
  [
    `${merge} fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = merge(a, b) in {}; let main = 0;`,
    /Cannot prove disjoint/,
  ],
  [
    "fn bad<A: Row<Type>>(a: Record<A>) -> {} = let unused = a ++ a in {}; let main = 0;",
    /row with itself/,
  ],
  [
    "fn bad<A: Row<Type>>(a: Record<A>) -> Record<A> where disjoint(A, A) = a; let main = 0;",
    /row with itself/,
  ],
  [
    "fn bad(x: number) -> number where disjoint({ x: number }, { x: boolean }) = x; let main = 0;",
    /Overlapping field/,
  ],
  ["fn bad<A>(a: A) -> A where disjoint(A, {}) = a; let main = 0;", /Expected Row/],
  [
    "fn bad<R: Row<Type>>(a: Record<R>) -> Record<R> where disjoint(R, { x: number }) = a; let main = bad({ x: 1 });",
    /Overlapping field/,
  ],
  [
    "fn bad<R: Row<Type>>(a: Record<R>) -> Record<R> where disjoint(R, { x: number }) = a; let main = bad({ x: true });",
    /Overlapping field/,
  ],
  [
    "fn f<A: Row<Type>, B: Row<Type>>(x: Record<A ++ B>) -> Record<A ++ B> where disjoint(A, B) = x; let main = f({ x: 1 });",
    /Ambiguous row decomposition/,
  ],
  [
    "fn f<R: Row<Type>>(x: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = x.x; let main = f({ x: true });",
    /Expected number/,
  ],
  [
    "fn f<R: Row<Type>>(x: Record<{ x: number } ++ R>) -> number where disjoint({ x: number }, R) = x.x; let main = f({ y: 1 });",
    /Missing field/,
  ],
  [
    "fn f<R: Row<Type>>(x: Record<R>, y: Record<R>) -> Record<R> = x; let main = f({ x: 1 }, { x: 1, y: 2 });",
    /rows do not match/,
  ],
  ["fn f(x: { x: number }) -> number = x.x; let main = f({ x: 1, y: 2 });", /rows do not match/],
  [
    `${identity} fn apply(f: number -> number) -> number = f(42); let main = apply(identity);`,
    /monomorphic function/,
  ],
  [`${identity} let main = identity(identity);`, /Polymorphic values/],
  [
    "fn f(x: number) -> number = g(x); fn g(x: number) -> number = x; let main = 0;",
    /Unknown value: g/,
  ],
  ["let x = let inner = 42 in inner; let main = inner;", /Unknown value/],
  ["fn f(x: number) -> number = x; let main = x;", /Unknown value/],
  ["let x = 42;", /Missing entry/],
  ["type Option<A> = None | Some(A); let main = 0;", /./],
] as const) {
  test(`Ur rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.errors.map(({ message }) => message).join("\n"), message);
  });
}

test("Ur's example prints its complete sensor report with null-prototype records", () => {
  const source = readFileSync(new URL("../examples/ur/main.ur", import.meta.url), "utf8");
  const { output, value } = execute(source);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), [
    { sensor: "north", value: 19, label: "reference", checked: true },
    {
      sensor: "south",
      value: 21,
      indoor: false,
      label: { priority: 2, active: true },
      checked: true,
    },
    { north: 21, south: 23 },
    { average: 22, difference: 2, status: "warm", unit: "C", selected: "south" },
    { capturedOffset: 21, expectedAverage: true, identityBoolean: true, identityString: "ready" },
  ]);

  const checkRecords = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    assert.equal(Object.getPrototypeOf(value), null);
    for (const field of Object.values(value)) checkRecords(field);
  };

  for (const record of output) checkRecords(record);
  checkRecords(value);
  assert.deepEqual(analyze(source).diagnostics, []);
});

test("Ur analysis reports call types, lexical definitions, and partial facts", () => {
  const source = `${identity} let value = 42; let main = let value = true in identity(value);`;
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  // The identifier carries the generic function type; the call's opening
  // parenthesis belongs to the call expression, whose result is boolean.
  assert.equal(
    show(typeAt(analysis, source.lastIndexOf("identity(value)") + "identity".length)!.type),
    "boolean",
  );
  const definition = definitionAt(analysis, source.lastIndexOf("value"));
  assert.equal(definition?.span.start, source.indexOf("value = true"));
  const bad = analyze("let x = 42; let main = missing;");
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(bad.definitions[0]?.name, "x");
  const partial = analyze("fn id<A>(value: A) -> A =");
  assert.equal(partial.diagnostics.length, 1);
  assert.ok(partial.tokens.length);
  assert.deepEqual(analyze(identity).diagnostics, []); // Libraries need no main during analysis.
});

test("Ur compilation is repeatable without retained substitutions", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(evaluate(`${identity} let main = identity(42);`), 42);
    assert.equal(evaluate(`${identity} let main = identity(true);`), true);
  }
});

test("Ur merge accepts exactly disjoint closed row pairs", () => {
  const labels = ["x", "constructor", "__proto__"];
  const literal = (mask: number) =>
    `{ ${labels.flatMap((label, i) => (mask & (1 << i) ? [`${label}: ${i + 1}`] : [])).join(", ")} }`;
  for (let left = 0; left < 8; left++)
    for (let right = 0; right < 8; right++) {
      const source = `${merge} let main = merge(${literal(left)}, ${literal(right)});`;
      const result = compile(source);
      assert.equal(result.success, (left & right) === 0, source);
      if (result.success) {
        const value = runInNewContext(result.value.javascript, {}, { timeout: 1000 });
        assert.equal(Object.getPrototypeOf(value), null);
        assert.deepEqual(
          Object.keys(value).sort(),
          labels.filter((_, i) => (left | right) & (1 << i)).sort(),
        );
      }
    }
});

test("Ur disjointness is symmetric but not transitive and never leaks between functions", () => {
  const notTransitive = compile(`
    fn bad<A: Row<Type>, B: Row<Type>, C: Row<Type>>(a: Record<A>, b: Record<B>, c: Record<C>) -> {}
    where disjoint(A, B), disjoint(B, C) = let unused = a ++ c in {};
    let main = 0;
  `);
  assert.equal(notTransitive.success, false);
  if (!notTransitive.success) assert.match(notTransitive.errors.map(({ message }) => message).join("\n"), /Cannot prove disjoint/);
  const noLeak = compile(`${merge}
    fn bad<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>) -> {} = let unused = a ++ b in {};
    let main = 0;
  `);
  assert.equal(noLeak.success, false);
  if (!noLeak.success) assert.match(noLeak.errors.map(({ message }) => message).join("\n"), /Cannot prove disjoint/);
});

test("Ur statement functions execute in order exactly once, even when results are discarded", () => {
  const { output, value } = execute(`
    fn log<A>(value: A) { print(value); }
    fn echo(value: number) -> number = let ignored = print(value) in value;
    fn add(left: number, right: number) -> number = left + right;
    fn main() {
      let first = echo(1);
      echo(2);
      let unused = echo(3);
      print(add(echo(4), echo(5)));
      log(first);
      99;
    }
  `);
  assert.deepEqual(output, [1, 2, 3, 4, 5, 9, 1]);
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Object.keys(value as object), []);
});

test("Ur statement locals are lexical, may shadow outer names, and capture earlier values", () => {
  const { output } = execute(`
    let value = 1;
    fn show(value: number) {
      let value = value + 1;
      let capture = fn() => value;
      print(let value = 100 in capture());
    }
    fn main() {
      let value = 10;
      show(value);
      print(value);
    }
  `);
  assert.deepEqual(output, [11, 10]);
});

test("Ur print is a normal aliasable and shadowable builtin", () => {
  assert.deepEqual(
    execute(`
    let output = print;
    fn main() {
      let print = fn(value: number) => value + 1;
      output(print(41));
    }
  `).output,
    [42],
  );
  assert.deepEqual(
    execute(`
    let output = print;
    fn print(value: number) -> number = value + 1;
    fn main() { output(print(41)); }
  `).output,
    [42],
  );
  assert.equal(evaluate("let print = 42; let main = print;"), 42);
});

test("Ur blocks are unit-returning and named entries are invoked, not function-valued lets", () => {
  for (const source of ["fn main() {}", "fn main() -> {} {}", "fn main() { 42; }"]) {
    const result = compiled(source);
    assert.equal(result.entry, "function");
    assert.equal(show(result.type), "{}");
    assert.deepEqual(execute(source).output, []);
  }
  assert.equal(evaluate("fn main() -> number = 42;"), 42);
  assert.equal(compiled("let main = fn() => 42;").entry, "value");
  assert.equal(typeof evaluate("let main = fn() => 42;"), "function");
});

test("Ur printing follows expression evaluation and only executes the selected branch", () => {
  assert.deepEqual(
    execute(`
    fn echo(value: number) -> number = let ignored = print(value) in value;
    fn main() {
      let ignored = { left: echo(1), right: echo(2) } ++ { last: echo(3) };
      if true then print(echo(4)) else print(echo(99));
      echo(5) + echo(6);
      (let ignored = print(7) in fn(value: number) => value)(echo(8));
    }
  `).output,
    [1, 2, 3, 4, 4, 5, 6, 7, 8],
  );
});

for (const [source, message] of [
  ["fn main(x: number) {}", /main must have no parameters/],
  ["fn main<A>() {}", /main must have no parameters/],
  ["fn main() -> number { 42; }", /Expected number/],
  ["fn main() { let x = 1; let x = 2; }", /Duplicate local declaration/],
  ["fn helper() { let hidden = 1; } fn main() { print(hidden); }", /Unknown value/],
  ["fn main() { print(later); let later = 1; }", /Unknown value/],
  ["fn main() { let bad: number = true; }", /Expected number/],
  ["fn main() { print(); }", /Expected 1 arguments/],
  ["fn main() { print(1, 2); }", /Expected 1 arguments/],
  ["fn main() { let print = 1; print(2); }", /Expected a function/],
  ["fn missing() = 42; let main = 0;", /require a return type/],
  ["fn main() { print(1) }", /./],
  ["fn bad<A>(value: A) { let n: number = value; } fn main() {}", /Expected number/],
] as const) {
  test(`Ur rejects invalid statement program: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.errors.map(({ message }) => message).join("\n"), message);
    assert.ok(analyze(source).diagnostics.length);
  });
}

test("Ur compile and analyze never execute prints, including top-level initializers", () => {
  const source = 'let ignored = print("initializing"); fn main() { print("running"); }';
  const original = console.log;
  const output: unknown[] = [];
  console.log = (...values: unknown[]) => {
    output.push(values);
  };
  try {
    assert.ok(compile(source).success);
    assert.deepEqual(analyze(source).diagnostics, []);
    assert.deepEqual(output, []);
  } finally {
    console.log = original;
  }
  assert.deepEqual(execute(source).output, ["initializing", "running"]);
});

test("Ur analysis tracks block local references and shadowing", () => {
  const source = "let value = 1; fn main() { let value = true; print(value); }";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const reference = source.lastIndexOf("value");
  assert.equal(show(typeAt(analysis, reference)!.type), "boolean");
  assert.equal(definitionAt(analysis, reference)!.span.start, source.indexOf("value = true"));
});

test("Ur CLI executes statement main without an extra result and preserves value entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "langkit-ur-blocks-"));
  const file = join(directory, "main.ur");
  const cli = fileURLToPath(new URL("../examples/ur/ur.ts", import.meta.url));
  try {
    for (const [source, expected] of [
      ['fn main() { print("first"); print(42); }', "first\n42\n"],
      ["fn main() {}", ""],
      ["fn main() -> number = 42;", ""],
      ["let main = 42;", "42\n"],
      ['let ignored = print("init"); let main = 42;', "init\n42\n"],
    ]) {
      writeFileSync(file, source!);
      const result = spawnSync(process.execPath, [cli, file], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
      assert.equal(result.stderr, "");
    }
    writeFileSync(file, "fn main(value: number) {}");
    const failed = spawnSync(process.execPath, [cli, file], { encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /main must have no parameters/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Ur reports both independent operand type errors", () => {
  const source = 'let main = true + "not a number";';
  const compiled = compile(source);
  assert.equal(compiled.success, false);
  if (!compiled.success) {
    assert.equal(compiled.errors.length, 2);
    assert.deepEqual(
      compiled.errors.map(({ span }) => {
        assert.ok(span);
        return source.slice(span.start, span.end).trim();
      }),
      ["true", '"not a number"'],
    );
  }
  assert.equal(analyze(source).diagnostics.length, 2);
});
