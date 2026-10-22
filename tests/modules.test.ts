import { type ImportParser, loadModules } from "langkit/modules";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = "file:///workspace/main.strict";
const useImports: ImportParser = (source) => ({
  success: true,
  value: [...source.matchAll(/use\("([^"]+)"\)/g)].map((match) => ({
    path: match[1]!,
    span: { start: match.index, end: match.index + match[0].length },
  })).toReversed(),
});

test("module graphs accept independently composed grammar and unsorted UTF-16 spans", () => {
  const source = "😀\r\nuse(\"./child.strict\")\nbody\nuse(\"./other.strict\")";
  const result = loadModules(source, { uri: root, read: () => "child" }, { extension: "strict", imports: useImports });
  assert.ok(result.success);
  const masked = result.value.modules.find((module) => module.uri === root)!.source;
  assert.equal(masked.length, source.length);
  assert.equal(masked, "😀\r\n" + " ".repeat(21) + "\nbody\n" + " ".repeat(21));
  assert.equal(result.value.modules.length, 3);
});

test("module graphs preserve parser failure details and dependency origin", () => {
  const source = "use(\"./child.strict\")";
  const imports: ImportParser = (text) =>
    text === source ? useImports(text) : ({
      success: false,
      errors: [
        {
          message: "custom syntax failure",
          context: ["custom imports"],
          span: { start: 1, end: 2 },
          related: [{
            message: "parser detail",
            location: { uri: "file:///detail.strict", span: { start: 3, end: 4 } },
          }],
        },
        { message: "failure without span", context: [] },
      ],
    });
  const result = loadModules(source, { uri: root, read: () => "bad" }, { extension: "strict", imports });
  assert.ok(!result.success);
  assert.equal(result.errors.length, 2);
  for (const error of result.errors) {
    assert.equal(error.origin?.uri, "file:///workspace/child.strict");
    assert.equal(error.location?.uri, root);
    assert.deepEqual(error.span, { start: 0, end: source.length });
  }
  assert.deepEqual(result.errors[0]!.context, ["custom imports"]);
  assert.ok(result.errors[0]!.related?.some((entry) => entry.message === "parser detail"));
});

test("module graphs reject invalid parser spans before reading dependencies", () => {
  for (
    const spans of [
      [{ start: -1, end: 2 }],
      [{ start: 0, end: 99 }],
      [{ start: 1, end: 1 }],
      [{ start: 0.5, end: 2 }],
      [{ start: NaN, end: 2 }],
      [{ start: 2, end: 1 }],
      [{ start: 0, end: 3 }, { start: 2, end: 4 }],
    ]
  ) {
    const result = loadModules("body", {
      uri: root,
      read: () => {
        throw new Error("must not read");
      },
    }, {
      extension: "strict",
      imports: () => ({ success: true, value: spans.map((span) => ({ path: "./child.strict", span })) }),
    });
    assert.ok(!result.success);
    assert.match(result.errors[0]!.message, /Invalid import directive span/);
    assert.equal(result.errors[0]!.origin?.uri, root);
  }
});

test("module graphs propagate parser programming exceptions", () => {
  const bug = new Error("parser bug");
  assert.throws(() =>
    loadModules("body", { uri: root }, {
      extension: "strict",
      imports: () => {
        throw bug;
      },
    }), (error) => error === bug);
});

test("module graph sources cannot be corrupted through the exposed map", () => {
  const source = "use(\"./child.strict\")";
  const result = loadModules(source, { uri: root, read: () => "child" }, { extension: "strict", imports: useImports });
  assert.ok(result.success);
  const graph = result.value;
  (graph.sources as Map<string, string>).clear();
  assert.equal(graph.sources.get(root), source);
});
