import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { compile, show } from "../examples/ur/ur.ts";

const identity = "fn id<A>(x: A) -> A = x;";
const keep = "fn keep<R: Row<Type>>(x: Record<R>) -> Record<R> = x;";
const merge = `
  fn merge<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>)
    -> Record<A ++ B> where disjoint(A, B) = a ++ b;
`;
const capture = `${merge}
  fn capture<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>)
    -> number -> Record<A ++ B> where disjoint(A, B) =
      fn(n: number) => merge(a, b);
`;
const tri = `${merge}
  fn tri<A: Row<Type>, B: Row<Type>, C: Row<Type>>(
    a: Record<A>, b: Record<B>, c: Record<C>
  ) -> Record<C ++ B ++ A>
  where disjoint(A, B), disjoint(A ++ B, C) = merge(c, merge(b, a));
`;
const wrappers = `${merge}
  fn wrap<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>)
    -> Record<A ++ B> where disjoint(A, B) = merge(a, b);
  fn again<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>)
    -> Record<A ++ B> where disjoint(A, B) = wrap(a, b);
  let alias = again;
`;

const accepts = (source: string, expected: unknown, expectedType?: string): void => {
  const result = compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  if (expectedType !== undefined) assert.equal(show(result.value.type), expectedType);

  const output: unknown[] = [];
  const value: unknown = runInNewContext(
    result.value.javascript,
    { console: { log: (...args: unknown[]) => output.push(args) } },
    { timeout: 1000 },
  );
  assert.deepEqual(output, [], "Pure probes must not print");

  // Compare exact fields and primitive values without losing special property
  // names or undefined values through JSON serialization / object assignment.
  const compare = (actual: unknown, wanted: unknown): void => {
    if (wanted === null || typeof wanted !== "object") {
      assert.equal(actual, wanted);
      return;
    }

    assert.ok(actual !== null && typeof actual === "object");
    assert.equal(Object.getPrototypeOf(actual), null);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(wanted).sort());
    for (const key of Object.keys(wanted)) {
      compare((actual as Record<string, unknown>)[key], (wanted as Record<string, unknown>)[key]);
    }
  };

  compare(value, expected);
};

const rejects = (source: string, diagnostic: RegExp): void => {
  const result = compile(source);
  assert.equal(result.success, false, "Ill-typed probe must not compile");
  if (!result.success) assert.ok(result.errors.some(error => diagnostic.test(error.message)));
};

const positive: readonly [string, string, unknown, string?][] = [
  [
    "substitutes independent generic closure results",
    `fn constant<A>(x: A) -> number -> A = fn(n: number) => x;
     let main = { a: constant(true)(4), b: constant("s")(0) };`,
    { a: true, b: "s" },
    "{ a: boolean, b: string }",
  ],
  [
    "substitutes a record through two nested closures",
    `fn constant<A>(x: A) -> number -> boolean -> A =
       fn(n: number) => fn(b: boolean) => x;
     let main = constant({ x: 42 })(1)(false).x;`,
    42,
    "number",
  ],
  [
    "preserves polymorphism through an abstract row",
    `${identity} ${keep}
     let fs = keep({ id: id });
     let main = { x: fs.id(42), y: fs.id(true) };`,
    { x: 42, y: true },
    "{ x: number, y: boolean }",
  ],
  [
    "preserves polymorphism through row concatenation",
    `${identity} ${merge}
     let fs = merge({ id: id }, { extra: true });
     let main = { x: fs.id(42), y: fs.id(true), extra: fs.extra };`,
    { x: 42, y: true, extra: true },
  ],
  [
    "retains a captured disjointness constraint in a closure",
    `${capture} let main = capture({ x: 1 }, { y: true })(0);`,
    { x: 1, y: true },
  ],
  [
    "preserves a constrained polymorphic function inside a row",
    `${merge} ${keep}
     let fs = keep({ merge: merge });
     let main = fs.merge({ x: 1 }, { y: true });`,
    { x: 1, y: true },
  ],
  [
    "forwards composite constraints with heterogeneous reversed rows",
    `${tri} let main = tri({ x: 1 }, { y: true }, { z: "s" });`,
    { x: 1, y: true, z: "s" },
  ],
  [
    "forwards constraints through wrapper aliases with special field names",
    `${wrappers} let main = alias({ __proto__: 1 }, { constructor: true });`,
    { ["__proto__"]: 1, constructor: true },
  ],
];

for (const [name, source, expected, expectedType] of positive) {
  test(`Ur adversarial: ${name}`, () => accepts(source, expected, expectedType));
}

const negative: readonly [string, string, RegExp][] = [
  [
    "cannot launder row-carried polymorphism into an ordinary type argument",
    `${identity} ${keep} let fs = keep({ id: id }); let main = id(fs);`,
    /Polymorphic values cannot be passed as generic arguments/,
  ],
  [
    "row-carried polymorphic merge retains its disjointness obligation",
    `${merge} ${keep} let fs = keep({ merge: merge });
     let main = fs.merge({ x: 1 }, { x: true });`,
    /Overlapping field: x/,
  ],
  [
    "captured constraint cannot admit overlapping rows",
    `${capture} let main = capture({ x: 1 }, { x: true })(0);`,
    /Overlapping field: x/,
  ],
  [
    "rigid parameters cannot become numeric through a lambda call",
    `fn bad<A>(x: A) -> A = (fn(y: number) => y)(x); let main = bad(true);`,
    /Expected number, found A/,
  ],
  [
    "returned closure substitution cannot lie to an annotation",
    `fn constant<A>(x: A) -> number -> A = fn(n: number) => x;
     let main: number = constant(true)(0);`,
    /Expected number, found boolean/,
  ],
  [
    "function argument inference must agree with the value argument",
    `fn ap<A>(f: A -> A, x: A) -> A = f(x);
     let main = ap(fn(x: number) => x + 1, true);`,
    /Expected number, found boolean/,
  ],
  [
    "wrapper aliases cannot erase special-name collisions",
    `${wrappers} let main = alias({ __proto__: 1 }, { __proto__: true });`,
    /Overlapping field: __proto__/,
  ],
  [
    "repeated residual rows retain field types",
    `fn f<R: Row<Type>>(a: Record<R>, b: Record<R>) -> Record<R> = b;
     let main = f({ x: 1 }, { x: true });`,
    /Expected number, found boolean/,
  ],
  [
    "record substitution through a closure retains projected field types",
    `fn constRow<R: Row<Type>>(x: Record<R>) -> number -> Record<R> =
       fn(n: number) => x;
     let main = constRow({ x: true })(0).x + 1;`,
    /Expected number, found boolean/,
  ],
  [
    "a known generic field must agree with a later argument",
    `fn get<A, R: Row<Type>>(x: Record<{ v: A } ++ R>, y: A) -> A
       where disjoint({ v: A }, R) = x.v;
     let main = get({ v: true, x: 1 }, 42);`,
    /Expected boolean, found number/,
  ],
  [
    "a rigid type parameter cannot be self-applied",
    "fn bad<A>(x: A) -> A = x(x); let main = 0;",
    /Expected a function, found A/,
  ],
];

for (const [name, source, diagnostic] of negative) {
  test(`Ur adversarial: ${name}`, () => rejects(source, diagnostic));
}

test("Ur adversarial: all 512 three-row subsets preserve values or reject overlaps", () => {
  const fields = ["x", "y", "z"];
  let accepted = 0;
  let rejected = 0;

  // Distinct values for each source row and label catch lost/overwritten fields,
  // not merely incorrect field counts or nonnumeric results.
  const entries = (mask: number, rowIndex: number): [string, number][] =>
    fields.flatMap((name, index) =>
      mask & (1 << index) ? [[name, rowIndex * 10 + index + 1] as [string, number]] : [],
    );

  const literal = (items: readonly [string, number][]): string =>
    `{ ${items.map(([name, value]) => `${name}: ${value}`).join(", ")} }`;

  for (let a = 0; a < 8; a++) {
    for (let b = 0; b < 8; b++) {
      for (let c = 0; c < 8; c++) {
        const rows = [entries(a, 0), entries(b, 1), entries(c, 2)];
        const source = `${tri} let main = tri(${rows.map(literal).join(", ")});`;
        const overlapping = (a & b) | (a & c) | (b & c);

        if (overlapping !== 0) {
          rejects(source, /Overlapping field: [xyz]/);
          rejected++;
        } else {
          accepts(source, Object.fromEntries(rows.flat()));
          accepted++;
        }
      }
    }
  }

  // Each of three labels may occur in none or exactly one of the three rows:
  // 4^3 valid assignments out of 8^3 total subset triples.
  assert.equal(accepted, 64);
  assert.equal(rejected, 448);
});
