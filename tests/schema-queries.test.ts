import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { host } from "../examples/schema/schema-host.ts";
import { compile } from "../examples/schema/schema.ts";
import { statement } from "../examples/schema/sql.ts";

const models = `model User = { id : Int |> primaryKey |> autoIncrement, email : String |> unique }
  |> many posts = Post.author
  |> one profile = Profile.user
model Post = {
  id : Int |> primaryKey |> autoIncrement,
  title : String,
  authorId : Int |> references User.id as author,
  editorId : Int? |> references User.id as editor
}
model Profile = { id : Int |> primaryKey, userId : Int |> unique |> references User.id as user }
`;

const errors = (source: string) => {
  const result = compile(source);
  assert.ok(!result.success, "source must not compile");
  return result.errors.map(({ message, span }) => ({ message, at: source.slice(span!.start, span!.end) }));
};

test("relations: forward and reverse relations resolve to correlated columns and arities", () => {
  const result = compile(models);
  assert.ok(result.success);
  const relations = Object.fromEntries(
    [...result.value.schema.relations].map(([model, owned]) => [
      model,
      [...owned.values()].map(({ name, target, inner, outer, arity }) =>
        `${name.name}: ${target}.${inner} = ${outer} (${arity})`
      ),
    ]),
  );
  assert.deepEqual(relations, {
    Post: ["author: User.id = authorId (one)", "editor: User.id = editorId (optional)"],
    Profile: ["user: User.id = userId (one)"],
    User: ["posts: Post.authorId = id (many)", "profile: Profile.userId = id (optional)"],
  });
});

test("relations: each declaration error lands on the guest name it is about", () => {
  const cases: readonly (readonly [string, string, { message: string; at: string; }])[] = [
    ["Post.author", "Post.writer", { message: "Unknown relation: Post.writer", at: "writer" }],
    ["many posts = Post.author", "many posts = Pots.author", { message: "Unknown model: Pots", at: "Pots" }],
    ["one profile = Profile.user", "one post = Post.author", {
      message: "Post.authorId is not unique; use many",
      at: "one",
    }],
    ["as editor", "as authorId", { message: "Duplicate field or relation: Post.authorId", at: "authorId" }],
  ];
  for (const [original, replacement, expected] of cases) {
    const source = models.replace(original, replacement);
    assert.deepEqual(errors(source), [expected], replacement);
  }
});

test("relations: a reverse relation must point back at its owner", () => {
  const source = models + "model Team = { id : Int |> primaryKey } |> many members = Post.author\n";
  assert.deepEqual(errors(source), [{ message: "Post.author points at User, not Team", at: "author" }]);
});

const blog = readFileSync(new URL("../examples/schema/blog.schema", import.meta.url), "utf8");

type Mistake = {
  readonly original: string;
  readonly replacement: string;
  readonly message: string;
  readonly at: string;
};

const mistakes: readonly Mistake[] = [
  {
    original: "{ .id, .title, .status,",
    replacement: "{ .id, .titel, .status,",
    message: "Unknown field: Post.titel",
    at: "titel",
  },
  {
    original: "commentCount: .comments |>",
    replacement: "commentCount: .commments |>",
    message: "Unknown relation: Post.commments",
    at: "commments",
  },
  {
    original: "where .authorId == author and .status == PostStatus.Draft |> delete",
    replacement: "where .id == author and .status == PostStatus.Draft |> delete",
    message: "Cannot compare PostId with UserId",
    at: ".id == author",
  },
  {
    original: "where before == null or",
    replacement: "where .title == null or",
    message: "Post.title is never null",
    at: ".title == null",
  },
  {
    original: "Role.Admin |> newestFirst |> first",
    replacement: "Role.Admin |> first",
    message: "first picks an arbitrary Post; add orderBy or match a unique field",
    at: "first",
  },
  {
    original: "Comment |> where .authorId == author |> update",
    replacement: "Comment |> update",
    message: "update without where changes every Comment; write where true",
    at: "update",
  },
  {
    original: "query draftCount",
    replacement: "query invite(role: Role) = User |> insert { role }\n\nquery draftCount",
    message: "insert User is missing email",
    at: "insert { role }",
  },
  {
    original: "query postsBy(author: User.id, skip: Int)",
    replacement: "query postsBy(author: User.id, skip: Int, page: Int)",
    message: "Unused parameter: page",
    at: "page",
  },
  {
    original: "  |> authored\n  |> timestamps\n  |> index [.postId",
    replacement: "  |> authored\n  |> published\n  |> index [.postId",
    message: "published is a query helper; it cannot apply to model Comment",
    at: "published\n  |> index",
  },
  {
    original: "|> published\n    |> where before",
    replacement: "|> timestamps\n    |> where before",
    message: "timestamps is a model helper; it cannot apply to a query",
    at: "timestamps",
  },
  {
    original: "where .featured and",
    replacement: "where .title and",
    message: "and needs Bool, got String",
    at: ".title and",
  },
  {
    original: "where .featured and .author.role == Role.Admin",
    replacement: "where .featured and .authorId == 1",
    message: "A UserId comes from a User.id parameter, not a literal",
    at: "1",
  },
  {
    original: "|> limit n\n    |> select",
    replacement: "|> select { .id }\n    |> limit n\n    |> select",
    message: "limit cannot follow select",
    at: "limit n",
  },
];

test("queries: each mistake is one guest diagnostic at the guest span it is about", () => {
  assert.equal(compile(blog).success, true);
  for (const { original, replacement, message, at } of mistakes) {
    assert.ok(blog.includes(original), original);
    const source = blog.replace(original, replacement);
    const expected = source.indexOf(at.split("\n")[0]!, source.indexOf(replacement));
    const result = compile(source);
    assert.ok(!result.success, replacement);
    assert.deepEqual(
      result.errors.map((error) => ({ message: error.message, start: error.span?.start })),
      [{ message, start: expected }],
      replacement,
    );
  }
});

const compiledBlog = () => {
  const result = compile(blog);
  assert.ok(result.success);
  const db = new DatabaseSync(":memory:");
  db.exec(result.value.sql);
  const sql = new Map(result.value.queries.map((query) => [query.name.name, statement(query)]));
  return { db, queries: result.value.queries, sql };
};

test("sql: no correlated subquery in any blog statement scans a table", () => {
  const { db, queries, sql } = compiledBlog();
  assert.equal(queries.length, 12);
  for (const query of queries) {
    const nulls = Object.fromEntries(query.params.map((param) => [param.name.name, null]));
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql.get(query.name.name)}`).all(nulls);
    const children = Map.groupBy(plan, (row) => Number(row.parent));
    const below = (id: number): readonly string[] =>
      (children.get(id) ?? []).flatMap((row) => [String(row.detail), ...below(Number(row.id))]);
    for (const row of plan.filter((row) => String(row.detail).startsWith("CORRELATED"))) {
      const details = below(Number(row.id));
      const coroutines = new Set(details.flatMap((detail) => /^CO-ROUTINE (\S+)/.exec(detail)?.[1] ?? []));
      const scans = details.filter((detail) => /^SCAN (\S+)/.test(detail) && !coroutines.has(detail.split(" ")[1]!));
      assert.deepEqual(scans, [], `${query.name.name}: ${details.join("; ")}`);
    }
  }
});

test("sql: every blog statement runs, pages before projecting, and nests JSON with real booleans", () => {
  const { db, sql } = compiledBlog();
  const exec = (name: string) => db.prepare(sql.get(name)!);
  const id = (row: Record<string, SQLOutputValue> | undefined): number => Number(row!.id);
  const sai = id(exec("createUser").get({ email: "sai@example.com", role: "Admin" }));
  const kim = id(exec("createUser").get({ email: "kim@example.com", role: "Member" }));
  const hello = id(exec("createPost").get({ author: sai, title: "Hello", featured: 1, at: "2026-01-01 10:00:00" }));
  exec("createPost").get({ author: sai, title: "Draft", featured: 0, at: "2026-01-02 10:00:00" });
  exec("createPost").get({ author: kim, title: "Scratch", featured: 0, at: "2026-01-03 10:00:00" });
  const comments: readonly (readonly [string, number])[] = [
    ["2026-01-01 11:00:00", 0],
    ["2026-01-01 12:00:00", 1],
    ["2026-01-01 13:00:00", 0],
  ];
  for (const [at, hidden] of comments) {
    exec("addComment").run({ post: hello, author: kim, body: `at ${at}`, hidden, at });
  }
  assert.equal(exec("publish").run({ post: hello, editor: kim }).changes, 1);
  assert.equal(exec("publish").run({ post: hello, editor: kim }).changes, 0);
  const [entry, ...rest] = exec("feed").all({ n: 10, before: null });
  assert.equal(rest.length, 0);
  assert.equal(entry!.featured, 1);
  assert.deepEqual(JSON.parse(String(entry!.author)), { id: sai, email: "sai@example.com" });
  assert.deepEqual(JSON.parse(String(entry!.editor)), { email: "kim@example.com" });
  assert.deepEqual(JSON.parse(String(entry!.comments)), [
    { body: "at 2026-01-01 13:00:00", hidden: false, by: "kim@example.com" },
    { body: "at 2026-01-01 11:00:00", hidden: false, by: "kim@example.com" },
  ]);
  assert.equal(entry!.commentCount, 2);
  assert.deepEqual(exec("feed").all({ n: 10, before: "2026-01-01 00:00:00" }), []);
  assert.equal(exec("userByEmail").get({ email: "kim@example.com" })!.role, "Member");
  assert.equal(exec("latestStaffPick").get()!.title, "Hello");
  assert.deepEqual(exec("activeAuthors").all({ role: "Admin" }).map((row) => ({ ...row })), [
    { id: sai, email: "sai@example.com", drafts: 1 },
  ]);
  assert.deepEqual(exec("postsBy").all({ author: sai, skip: 0 }).map((row) => [row.title, row.editor]), [
    ["Draft", null],
    ["Hello", "{\"email\":\"kim@example.com\"}"],
  ]);
  assert.deepEqual(exec("postsBy").all({ author: sai, skip: 1 }).map((row) => row.id), [hello]);
  assert.equal(exec("draftCount").get({ author: sai })!.value, 1);
  assert.deepEqual(exec("hideComments").all({ author: kim }).map((row) => row.hidden), [1, 1, 1]);
  assert.equal(exec("purgeDrafts").run({ author: sai }).changes, 1);
  assert.equal(exec("draftCount").get({ author: sai })!.value, 0);
});

type Loaded = {
  readonly open: (path: string) => Readonly<Record<string, (params?: object) => unknown>> & {
    readonly init: () => void;
    readonly close: () => void;
    readonly transaction: <T>(body: () => T) => T;
  };
  readonly statements: Readonly<Record<string, string>>;
};

const scratch = mkdtempSync(join(tmpdir(), "schema-queries-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let modules = 0;
const load = async (source: string): Promise<Loaded> => {
  const { javascript, diagnostics } = host.host(source, "file:///blog.schema");
  assert.deepEqual(diagnostics, []);
  const file = join(scratch, `module-${modules++}.mjs`);
  writeFileSync(file, javascript!);
  return import(pathToFileURL(file).href);
};

const seeded = async () => {
  const { open, statements } = await load(blog);
  const db = open(":memory:");
  db.init();
  const sai = db.createUser!({ email: "sai@example.com", role: "Admin" }) as { readonly id: number; };
  const post = db.createPost!({ author: sai.id, title: "Hello", featured: true, at: "2026-01-01 10:00:00" }) as {
    readonly id: number;
  };
  db.addComment!({ post: post.id, author: sai.id, body: "first", hidden: false, at: "2026-01-01 11:00:00" });
  return { db, statements, sai, post };
};

test("runtime: a throwing transaction rolls back and a nested one rolls back only to its savepoint", async () => {
  const { db, sai } = await seeded();
  const drafts = () => db.draftCount!({ author: sai.id });
  const draft = (title: string) =>
    db.createPost!({ author: sai.id, title, featured: false, at: "2026-01-02 10:00:00" });
  assert.equal(drafts(), 1);
  assert.throws(() =>
    db.transaction(() => {
      draft("lost");
      throw new Error("abort");
    }), /abort/);
  assert.equal(drafts(), 1);
  db.transaction(() => {
    draft("kept");
    assert.throws(() =>
      db.transaction(() => {
        draft("inner");
        throw new Error("inner abort");
      }), /inner abort/);
  });
  assert.equal(drafts(), 2);
  assert.throws(() => db.transaction(async () => draft("async")), /must be synchronous/);
  assert.equal(drafts(), 2);
});

test("runtime: open refuses a database whose DDL fingerprint differs", async () => {
  const file = join(scratch, "fingerprint.db");
  const first = (await load(blog)).open(file);
  first.init();
  first.close();
  const { open } = await load(blog.replace("title : String,", "title : String,\n  subtitle : String?,"));
  assert.throws(() => open(file), /schema fingerprint \d+, but this schema is \d+/);
  const reopened = (await load(blog)).open(file);
  reopened.init();
  reopened.close();
});

test("runtime: rows decode Bool to booleans at the top level and inside JSON, and a missing to-one to null", async () => {
  const { db, statements, sai, post } = await seeded();
  db.createPost!({ author: sai.id, title: "Draft", featured: false, at: "2026-01-03 10:00:00" });
  assert.equal(db.publish!({ post: post.id, editor: sai.id }), 1);
  assert.deepEqual(db.postsBy!({ author: sai.id, skip: 0 }), [
    { id: post.id + 1, title: "Draft", status: "Draft", featured: false, editor: null },
    { id: post.id, title: "Hello", status: "Published", featured: true, editor: { email: "sai@example.com" } },
  ]);
  assert.deepEqual(db.feed!({ n: 10, before: null }), [{
    id: post.id,
    title: "Hello",
    featured: true,
    author: { id: sai.id, email: "sai@example.com" },
    editor: { email: "sai@example.com" },
    comments: [{ body: "first", hidden: false, by: "sai@example.com" }],
    commentCount: 1,
  }]);
  assert.deepEqual(db.hideComments!({ author: sai.id }), [{ id: 1, hidden: true }]);
  assert.deepEqual(db.feed!({ n: 1, before: null }), [{
    id: post.id,
    title: "Hello",
    featured: true,
    author: { id: sai.id, email: "sai@example.com" },
    editor: { email: "sai@example.com" },
    comments: [],
    commentCount: 0,
  }]);
  assert.equal(db.userByEmail!({ email: "nobody@example.com" }), undefined);
  assert.ok(statements.feed!.startsWith("SELECT"));
});
