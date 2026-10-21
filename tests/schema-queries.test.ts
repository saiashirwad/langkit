import assert from "node:assert/strict";
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
