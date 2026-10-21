import { project } from "langkit/host";
import assert from "node:assert/strict";
import { test } from "node:test";
import { host } from "../examples/schema/schema-host.ts";

const hosted = (source: string) => {
  const { declarations, diagnostics, javascript } = host.host(source, "file:///test.schema");
  return { text: project(declarations).text, diagnostics, javascript };
};

test("schema host: nullable, defaulted, and auto-increment fields shape the row and insert types", () => {
  const { text, diagnostics } = hosted(
    "model Note = { id : Int |> primaryKey |> autoIncrement, body : String?, pinned : Bool |> default false, title : String }\n",
  );
  assert.deepEqual(diagnostics, []);
  assert.ok(text.includes("readonly body: string | null;"), text);
  assert.ok(
    text.includes(
      "export interface NewNote {\n  readonly body?: string | null;\n  readonly pinned?: boolean;\n  readonly title: string;\n}",
    ),
    text,
  );
});

test("schema host: a reference takes the type of the field it references", () => {
  const { text } = hosted(
    "model A = { id : Int |> primaryKey, code : String |> unique }\n"
      + "model B = { id : Int |> primaryKey |> references A.id, aCode : String |> references A.code }\n",
  );
  assert.ok(text.includes("export type BId = AId;"), text);
  assert.ok(text.includes("readonly aCode: string;"), text);
});

test("schema host: names TypeScript cannot declare become guest diagnostics", () => {
  const source =
    "type string = A | B\nmodel User = { id : Int |> primaryKey }\nmodel UserId = { id : Int |> primaryKey }\n";
  const { diagnostics, javascript } = hosted(source);
  assert.equal(javascript, undefined);
  assert.deepEqual(
    diagnostics.map(({ message, span }) => ({ message, at: source.slice(span!.start, span!.end) })),
    [
      { message: "TypeScript cannot represent string, a reserved type name", at: "string" },
      { message: "TypeScript cannot represent UserId, which collides with a name derived from User", at: "UserId" },
    ],
  );
});

test("schema host: cyclic references have no faithful type", () => {
  const { diagnostics } = hosted(
    "model A = { id : Int |> primaryKey, b : Int |> unique |> references B.a }\n"
      + "model B = { id : Int |> primaryKey, a : Int |> unique |> references A.b }\n",
  );
  assert.deepEqual(diagnostics.map(({ message }) => message), [
    "TypeScript cannot represent A.b, whose references form a cycle",
    "TypeScript cannot represent B.a, whose references form a cycle",
  ]);
});

test("schema host: queries project onto Database members, which a query name or model cannot shadow", () => {
  const source = "model Database = { id : Int |> primaryKey }\nquery init = Database |> count\n";
  const { diagnostics, javascript } = hosted(source);
  assert.equal(javascript, undefined);
  assert.deepEqual(
    diagnostics.map(({ message, span }) => ({ message, at: source.slice(span!.start, span!.end) })),
    [
      { message: "TypeScript cannot represent Database, a reserved type name", at: "Database" },
      { message: "TypeScript cannot represent init, a Database member", at: "init" },
    ],
  );
  const { text } = hosted(
    "model Note = { id : Int |> primaryKey, body : String? }\nquery note(id: Note.id) = Note |> where .id == id |> select { .body } |> first\n",
  );
  assert.ok(
    text.includes("note(params: { readonly id: NoteId; }): { readonly body: string | null; } | undefined;"),
    text,
  );
  assert.ok(text.includes("   * SELECT \"t0\".\"body\" AS \"body\"\n"), text);
});
