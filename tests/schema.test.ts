import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { render } from "langkit";
import { definitionAt, typeAt } from "langkit/analysis";
import { analyze, compile } from "../examples/schema/schema.ts";
import { parse } from "../examples/schema/schema-syntax.ts";

const compiled = (source: string) => {
  const result = compile(source);
  if (!result.success) assert.fail(render(result.error, source));
  return result.value;
};

const database = (source: string, body: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(compiled(source).sql);
    body(db);
  } finally {
    db.close();
  }
};

const row = (db: DatabaseSync, sql: string) => ({ ...db.prepare(sql).get() });

const sample = `
// Reusable, forward-referenced helper composition.
let audited = fn(m) => m |> timestamps |> index [.createdAt]
let timestamps = fn(model) => model |> extend {
  createdAt : DateTime |> default now,
  updatedAt : DateTime |> default now,
}
type Role = User | Admin
model Post = {
  id : Int |> primaryKey |> autoIncrement,
  title : String,
  authorId : Int |> references User.id,
  published : Bool |> default false,
} |> audited |> index [.authorId, .createdAt]
model User = {
  id : Int |> primaryKey |> autoIncrement,
  email : String |> unique,
  name : String?,
  role : Role |> default Role.User,
} |> audited
`;

test("schema: the publishing platform example creates a working SQLite schema", () => {
  const source = readFileSync(new URL("../examples/schema/main.schema", import.meta.url), "utf8");
  const schema = compiled(source).schema;
  assert.equal(schema.models.length, 190);
  for (const [prefix, count] of [
    ["Editorial", 43],
    ["Community", 43],
    ["Commerce", 43],
    ["Operations", 42],
  ] as const) {
    assert.equal(schema.models.filter((model) => model.name.name.startsWith(prefix)).length, count);
  }
  assert.deepEqual(analyze(source).diagnostics, []);
  database(source, (db) => {
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    assert.equal(tables.length, schema.models.length);
    // Preparing DML also catches foreign-key mismatches that CREATE TABLE allows.
    for (const table of tables) db.prepare(`EXPLAIN INSERT INTO "${table.name}" DEFAULT VALUES`);
    db.exec(`
      INSERT INTO User (email, username) VALUES ('author@example.com', 'author');
      INSERT INTO Team (slug, name, ownerId) VALUES ('editors', 'Editors', 1);
      INSERT INTO TeamMember (teamId, userId) VALUES (1, 1);
      INSERT INTO Publication (teamId, slug, title) VALUES (1, 'journal', 'Journal');
      INSERT INTO Post (publicationId, slug, title, authorId) VALUES (1, 'hello', 'Hello', 1);
      INSERT INTO PostRevision (postId, number, title, body, authorId) VALUES (1, 1, 'Hello', 'First draft', 1);
      INSERT INTO Comment (postId, body, authorId) VALUES (1, 'A comment', 1);
      INSERT INTO Comment (postId, parentId, body, authorId) VALUES (1, 1, 'A reply', 1);
      INSERT INTO Subscription (userId, publicationId) VALUES (1, 1);
      INSERT INTO Notification (recipientId, actorId, postId, commentId, kind, message)
        VALUES (1, 1, 1, 2, 'Reply', 'A new reply');
    `);
    assert.equal(row(db, "SELECT status FROM Post").status, "Draft");
    assert.equal(row(db, "SELECT status FROM Subscription").status, "Active");
    assert.equal(row(db, "SELECT parentId FROM Comment WHERE id = 2").parentId, 1);
    assert.throws(() => db.exec("INSERT INTO TeamMember (teamId, userId) VALUES (1, 1)"), /UNIQUE/);
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO Comment (postId, parentId, body, authorId) VALUES (1, 999, 'Orphan', 1)",
        ),
      /FOREIGN KEY/,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
});

test("schema: generated SQLite executes defaults, helpers, indexes and foreign keys", () => {
  const result = compiled(sample);
  assert.deepEqual(
    result.schema.models[0]!.fields.map((field) => field.name.name),
    ["id", "title", "authorId", "published", "createdAt", "updatedAt"],
  );
  assert.equal(result.sql, compiled(sample).sql);
  database(sample, (db) => {
    assert.equal(row(db, "PRAGMA foreign_keys").foreign_keys, 1);
    db.exec(
      "INSERT INTO User (email) VALUES ('one@example.com'); INSERT INTO User (email) VALUES ('two@example.com');",
    );
    assert.deepEqual(row(db, "SELECT id, name, role FROM User WHERE id = 1"), {
      id: 1,
      name: null,
      role: "User",
    });
    assert.equal(row(db, "SELECT id FROM User WHERE email = 'two@example.com'").id, 2);
    assert.match(
      String(row(db, "SELECT createdAt FROM User WHERE id = 1").createdAt),
      /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/,
    );
    db.exec("INSERT INTO Post (title, authorId) VALUES ('Hello', 1)");
    assert.equal(row(db, "SELECT published FROM Post").published, 0);
    assert.throws(
      () => db.exec("INSERT INTO Post (title, authorId) VALUES ('Orphan', 999)"),
      /FOREIGN KEY/,
    );
    assert.throws(() => db.exec("DELETE FROM User WHERE id = 1"), /FOREIGN KEY/);
    assert.throws(() => db.exec("INSERT INTO User (email) VALUES ('one@example.com')"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO User (email, role) VALUES ('bad', 'Owner')"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO User (email) VALUES (NULL)"), /NOT NULL/);
    assert.throws(
      () => db.exec("INSERT INTO Post (title, authorId, published) VALUES ('Bad', 1, 2)"),
      /CHECK/,
    );
    assert.throws(
      () => db.exec("INSERT INTO Post (title, authorId) VALUES ('Bad', 'not an integer')"),
      /cannot store TEXT/,
    );
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      .all();
    assert.equal(indexes.length, 3);
    const columns = indexes.map((index) =>
      db
        .prepare(`PRAGMA index_info('${index.name}')`)
        .all()
        .map((column) => column.name),
    );
    assert.ok(columns.some((names) => names.join(",") === "authorId,createdAt"));
  });
});

test("schema: composite uniqueness, nullable enum/bool and singleton unique references", () => {
  database(
    `
    type State = Open | Closed
    model Child = { parent : String? |> references Parent.code, state : State?, flag : Bool? }
    model Parent = { code : String, region : String } |> unique [.code] |> unique [.code, .region]
    model Pair = { a : Int, b : Int } |> unique [.a, .b]
  `,
    (db) => {
      db.exec(
        "INSERT INTO Child DEFAULT VALUES; INSERT INTO Parent VALUES ('x', 'north'); INSERT INTO Child (parent) VALUES ('x');",
      );
      assert.deepEqual(row(db, "SELECT parent, state, flag FROM Child WHERE parent IS NULL"), {
        parent: null,
        state: null,
        flag: null,
      });
      assert.throws(() => db.exec("INSERT INTO Child (parent) VALUES ('missing')"), /FOREIGN KEY/);
      db.exec("INSERT INTO Pair VALUES (1, 1), (1, 2), (2, 1)");
      assert.throws(() => db.exec("INSERT INTO Pair VALUES (1, 1)"), /UNIQUE/);
    },
  );
});

test("schema: literals are quoted safely and SQL identifier keywords work", () => {
  const text = "O'Reilly'); DROP TABLE select; --\n\u0000end";
  database(
    `model select = {
    from : String |> default ${JSON.stringify(text)},
    n : Int |> default -42,
    f : Float |> default 1.25,
    b : Bool |> default true
  }`,
    (db) => {
      db.exec('INSERT INTO "select" DEFAULT VALUES');
      assert.deepEqual(row(db, 'SELECT * FROM "select"'), { from: text, n: -42, f: 1.25, b: 1 });
    },
  );
});

test("schema: generated index names cannot collide with table names", () => {
  database(
    `
    model __schema_index_0 = { id : Int } |> index [.id]
    model __schema_index_1 = { id : Int } |> index [.id]
  `,
    (db) => {
      assert.equal(row(db, "SELECT count(*) AS n FROM sqlite_master WHERE type = 'index'").n, 2);
    },
  );
});

test("schema: pipelines preserve the input and can select later extensions", () => {
  const source = `
    let identity = fn(x) => x
    let indexed = fn(x) => x |> index [.extra]
    model Item = { id : Int } |> identity |> indexed |> extend { extra : String }
  `;
  const model = compiled(source).schema.models[0]!;
  assert.deepEqual(
    model.fields.map((field) => field.name.name),
    ["id", "extra"],
  );
  database(source, (db) => db.exec("INSERT INTO Item VALUES (1, 'ok')"));
});

for (const [source, message] of [
  ["model A = {}", /at least one field/],
  ["model A = { x : Int, x : String }", /Duplicate field/],
  ["model A = { x : Int, X : String }", /Duplicate field/],
  ["model A = { x : Int } model a = { y : Int }", /case-insensitive/],
  ["model sqlite_private = { x : Int }", /reserves table names/],
  ["model A = { x : Int } model A = { y : Int }", /Duplicate or reserved/],
  ["type Int = One", /Duplicate or reserved/],
  ["type Role = User | User", /Duplicate enum member/],
  ["model A = { x : Missing }", /Unknown field type/],
  ["model A = { x : Int } |> missing", /Unknown model helper/],
  ["let f = fn(x) => x |> missing", /Unknown model helper/],
  ["let f = fn(x) => x |> f", /Recursive model helpers/],
  ["let f = fn(x) => x |> g let g = fn(x) => x |> f", /Recursive model helpers/],
  ["let f = fn(x) => y", /must start from its parameter/],
  ["let f = fn(x) => { y : Int }", /must start from its parameter/],
  ["model A = other", /must start with a field block/],
  ["let extend = fn(x) => x", /Duplicate or reserved/],
  [
    "let extra = fn(x) => x |> extend { id : Int } model A = { id : Int } |> extra",
    /Duplicate field/,
  ],
  [
    "let extra = fn(x) => x |> extend { id : Int } model A = { a : Int } |> extra |> extra",
    /Duplicate field/,
  ],
  ["let unused = fn(x) => x |> extend { y : Unknown }", /Unknown field type/],
  ["model A = { x : Int |> default true }", /Invalid default/],
  ["model A = { x : Int |> default 1.5 }", /Invalid default/],
  ["model A = { x : Int |> default 9007199254740992 }", /Invalid default/],
  ["model A = { x : String |> default now }", /Invalid default/],
  ["model A = { x : Bool |> default 1 }", /Invalid default/],
  ["type Role = User model A = { x : Role |> default Role.Missing }", /Unknown enum value/],
  [
    "type Role = User type Other = User model A = { x : Role |> default Other.User }",
    /Invalid default/,
  ],
  ["model A = { x : Int |> default 1 |> default 2 }", /Duplicate field operation/],
  ["model A = { x : Int? |> primaryKey }", /cannot be optional/],
  ["model A = { x : Int |> primaryKey, y : Int |> primaryKey }", /only one primary key/],
  ["model A = { x : Int |> autoIncrement }", /requires an Int primary key/],
  ["model A = { x : String |> primaryKey |> autoIncrement }", /requires an Int primary key/],
  ["model A = { x : Int |> primaryKey |> autoIncrement |> default 1 }", /cannot have a default/],
  ["model A = { x : Int |> references Missing.id }", /Unknown model/],
  [
    "model A = { x : Int |> references B.missing } model B = { id : Int |> primaryKey }",
    /Unknown field/,
  ],
  [
    "model A = { x : String |> references B.id } model B = { id : Int |> primaryKey }",
    /Foreign key types differ/,
  ],
  ["model A = { x : Int |> references B.id } model B = { id : Int }", /primary key or unique/],
  ["model A = { x : Int } |> index [.missing]", /Unknown field/],
  ["model A = { x : Int } |> index [.x, .x]", /Repeated field/],
  ["model A = { x : Int } |> index [.x] |> index [.x]", /Duplicate model operation/],
] as const) {
  test(`schema rejects: ${source}`, () => {
    const result = compile(source);
    assert.equal(result.success, false);
    if (result.success) return;
    assert.match(result.error.message, message);
    assert.ok(result.error.span);
    assert.match(render(result.error, source), /\^/);
    assert.equal(analyze(source).diagnostics[0]?.message, result.error.message);
  });
}

for (const source of [
  "model A = { x Int }",
  "model A = { x : Int y : Int }",
  "model A = { x : Int",
  "model A = { x : Int |> }",
  "model A = { x : Int |> unknown }",
  "model A = { x : Int } |> index []",
  "model A = { x : Int } |> index [x]",
  "model A = { x : Int } garbage",
  'model A = { x : String |> default "\\q" }',
  "type Role =",
]) {
  test(`schema syntax rejects: ${source}`, () => {
    assert.equal(parse(source).success, false);
    assert.equal(compile(source).success, false);
    const analysis = analyze(source);
    assert.equal(analysis.diagnostics.length, 1);
    assert.ok(analysis.tokens.length > 0);
  });
}

test("schema: analysis resolves helper, parameter, enum, foreign key and selector names", () => {
  const source = `
    let added = fn(m) => m |> extend { extra : String? }
    type Role = User | Admin
    model Account = { id : Int |> primaryKey, role : Role |> default Role.Admin } |> added |> index [.extra]
    model Post = { author : Int |> references Account.id }
  `;
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const expectDefinition = (offset: number, declaration: string, name: string) => {
    const definition = definitionAt(analysis, offset);
    assert.ok(definition, `definition at ${offset}`);
    assert.equal(definition.name, name);
    assert.equal(definition.span.start, source.indexOf(declaration));
    assert.equal(source.slice(definition.span.start, definition.span.end), name);
  };
  expectDefinition(source.indexOf("|> added") + 3, "added =", "added");
  expectDefinition(source.indexOf("=> m") + 3, "m)", "m");
  expectDefinition(source.indexOf("role : Role") + 7, "Role =", "Role");
  expectDefinition(source.indexOf("Role.Admin") + 5, "Admin\n", "Admin");
  expectDefinition(source.indexOf("Account.id"), "Account =", "Account");
  expectDefinition(source.indexOf("Account.id") + 8, "id :", "id");
  expectDefinition(source.indexOf(".extra") + 1, "extra :", "extra");
  assert.equal(typeAt(analysis, source.indexOf(".extra") + 1)?.type, "String?");
  assert.equal(typeAt(analysis, source.indexOf("|> added") + 3)?.type, "Model -> Model");
});

test("schema: unused helper fields have type hovers", () => {
  const source =
    "let timestamps = fn(m) => m |> extend { createdAt : DateTime |> default now, label : String? }";
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(typeAt(analysis, source.indexOf("createdAt"))?.type, "DateTime");
  assert.equal(typeAt(analysis, source.indexOf("label"))?.type, "String?");
});

test("schema: repeated compilation and analysis do not leak facts", () => {
  const first = analyze("model A = { x : Int }");
  compiled(sample);
  const second = analyze("model B = { y : String }");
  assert.ok(first.definitions.some((definition) => definition.name === "A"));
  assert.ok(
    !second.definitions.some((definition) => definition.name === "A" || definition.name === "x"),
  );
  assert.deepEqual(second.diagnostics, []);
});
