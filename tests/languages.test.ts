import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as toy from "../examples/toy/toy.ts";
import * as hm from "../examples/hm/hm.ts";
import * as rows from "../examples/rows/rows.ts";
import * as advanced from "../examples/advanced/advanced.ts";
import * as strict from "../examples/strict/strict.ts";
import * as schema from "../examples/schema/schema.ts";
import * as shapes from "../examples/shapes/shapes.ts";
import * as ur from "../examples/ur/ur.ts";

const sample = (language: string) => {
  const url = new URL(`../examples/${language}/main.${language}`, import.meta.url);
  return { source: readFileSync(url, "utf8"), uri: url.href };
};

for (const [name, language] of [["toy", toy], ["hm", hm], ["rows", rows], ["advanced", advanced]] as const) {
  test(`${name}: representative source compiles and executes`, () => {
    const { source, uri } = sample(name);
    const result = language.compile(source, { uri });
    assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
    const output: unknown[] = [];
    const expected = name === "advanced" ? 49 : 42;
    assert.equal(runInNewContext(result.value.javascript, {
      console: { log: (value: unknown) => output.push(value) },
    }, { timeout: 1000 }), expected);
    assert.deepEqual(output, name === "rows" || name === "advanced" ? ["The answer is:", expected] : []);
  });
}

test("strict: source-defined Functor and Monad dictionaries compile and execute", () => {
  const source = `import "./stdlib.strict";
    calibrate readings = map (\\value -> value + 1) readings;
    main : Effect number;
    main = do {
      let answer = withDefault 0 (calibrate (Some 41));
      print answer;
      pure answer;
    };`;
  const result = strict.compile(source, { uri: new URL("../examples/strict/test.strict", import.meta.url).href });
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  const output: unknown[] = [];
  assert.equal(runInNewContext(`(${result.value.javascript})({})`, {
    console: { log: (value: unknown) => output.push(value) },
  }, { timeout: 1000 }), 42);
  assert.deepEqual(output, [42]);
});

test("shapes: named open records compile and immutable transformations execute", () => {
  const { source } = sample("shapes");
  const result = shapes.compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  const value = runInNewContext(result.value.javascript, {}, { timeout: 1000 });
  assert.deepEqual({ ...value }, {
    greeting: "Hello, Ada", age: 37, language: "Shapes", active: true, count: 42,
  });
});

test("ur: explicit row polymorphism compiles and disjoint records execute", () => {
  const source = `
    fn merge<A: Row<Type>, B: Row<Type>>(a: Record<A>, b: Record<B>)
      -> Record<A ++ B> where disjoint(A, B) = a ++ b;
    fn identity<A>(value: A) -> A = value;
    let main = merge({ answer: identity(42) }, { ready: identity(true) });
  `;
  const result = ur.compile(source);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  const value = runInNewContext(result.value.javascript, {}, { timeout: 1000 });
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual({ ...value }, { answer: 42, ready: true });
});

test("schema: helper pipelines compile to SQL and execute in SQLite", () => {
  const result = schema.compile(`
    let audited = fn(model) => model |> extend { createdAt : DateTime |> default now }
    type Role = User | Admin
    model User = {
      id : Int |> primaryKey |> autoIncrement,
      email : String |> unique,
      role : Role |> default Role.User,
    } |> audited
    model Post = {
      id : Int |> primaryKey |> autoIncrement,
      authorId : Int |> references User.id,
      published : Bool |> default false,
    }
  `);
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(result.value.sql);
    db.exec("INSERT INTO User (email) VALUES ('ada@example.com'); INSERT INTO Post (authorId) VALUES (1)");
    assert.deepEqual({ ...db.prepare("SELECT role, published FROM User JOIN Post ON User.id = Post.authorId").get() }, {
      role: "User", published: 0,
    });
    assert.throws(() => db.exec("INSERT INTO Post (authorId) VALUES (999)"), /FOREIGN KEY/);
  } finally {
    db.close();
  }
});
