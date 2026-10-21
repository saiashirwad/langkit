import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as advanced from "../examples/advanced/advanced.ts";
import * as hm from "../examples/hm/hm.ts";
import * as schema from "../examples/schema/schema.ts";
import * as toy from "../examples/toy/toy.ts";

const sample = (language: string) => {
  const url = new URL(`../examples/${language}/main.${language}`, import.meta.url);
  return { source: readFileSync(url, "utf8"), uri: url.href };
};

for (const [name, language] of [["toy", toy], ["hm", hm], ["advanced", advanced]] as const) {
  test(`${name}: representative source compiles and executes`, () => {
    const { source, uri } = sample(name);
    const result = language.compile(source, { uri });
    assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
    const output: unknown[] = [];
    const expected = name === "advanced" ? 49 : 42;
    assert.equal(
      runInNewContext(result.value.javascript, {
        console: { log: (value: unknown) => output.push(value) },
      }, { timeout: 1000 }),
      expected,
    );
    assert.deepEqual(output, name === "advanced" ? ["The answer is:", expected] : []);
  });
}

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
      role: "User",
      published: 0,
    });
    assert.throws(() => db.exec("INSERT INTO Post (authorId) VALUES (999)"), /FOREIGN KEY/);
  } finally {
    db.close();
  }
});

test("hm: aliases of lambda parameters remain monomorphic", () => {
  const result = hm.compile("fn(f) => let g = f in let x = g(1) in g(true)");
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.errors[0]!.message, /Cannot unify/);
});

test("advanced: explicit forall permits polymorphic recursion but cannot manufacture polymorphism", () => {
  const prefix = "import \"./stdlib.advanced\"; type Nest(a) = Done(a) | More(Nest(List(a))) ";
  const options = { uri: new URL("../examples/advanced/test.advanced", import.meta.url).href };
  const result = advanced.compile(
    prefix
      + "let rec depth: forall a. Nest(a) -> number = fn(n) => match n { Done(_) => 0, More(rest) => 1 + depth(rest) } in depth(More(Done(Cons(42, Nil))))",
    options,
  );
  assert.ok(result.success, result.success ? "" : JSON.stringify(result.errors));
  assert.equal(runInNewContext(result.value.javascript, {}, { timeout: 1000 }), 1);
  const invalid = advanced.compile("fn(r) => (r.x : forall a. a)");
  assert.equal(invalid.success, false);
  if (!invalid.success) assert.ok(invalid.errors.some(error => /escape|rigid|skolem/i.test(error.message)));
});
