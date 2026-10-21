import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compile } from "../examples/schema/schema.ts";

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
    original: "|> select { .title }",
    replacement: "|> select { .titel }",
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
    original: "PostStatus.Draft |> newestFirst |> first",
    replacement: "PostStatus.Draft |> first",
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
    original: "query staffPicks(skip: Int)",
    replacement: "query staffPicks(skip: Int, page: Int)",
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
