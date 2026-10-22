import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "../examples/grammar/grammar-syntax.ts";

const read = (name: string) => readFileSync(new URL(`../examples/grammar/${name}`, import.meta.url), "utf8");

test("the expression grammar parses with spans at the written text", () => {
  const source = read("expr.grammar");
  const parsed = parse(source);
  assert.ok(parsed.success);
  const slice = ({ start, end }: { readonly start: number; readonly end: number; }) => source.slice(start, end);
  const { name, items } = parsed.value;
  assert.equal(slice(name.span), "Expr");
  assert.deepEqual(items.map(({ kind }) => kind), ["skip", "word", "token", "rule", "rule", "rule"]);
  const rule = items[3]!;
  assert.ok(rule.kind === "rule" && rule.body.kind === "precedence");
  assert.deepEqual(rule.body.levels.map(({ assoc }) => assoc), [
    "left",
    "left",
    "prefix",
    "none",
    "left",
    "left",
    "prefix",
    "postfix",
  ]);
  assert.equal(slice(rule.body.levels[3]!.span), "none \"==\" | \"!=\" | \"<\" | \"<=\" | \">\" | \">=\"");
  const atoms = rule.body.atoms.map(({ span }) => slice(span));
  assert.deepEqual(atoms, ["Num", "Path", "\"(\" Expr \")\""]);
});

test("a sequence ends where the next rule's name and equals sign begin", () => {
  const parsed = parse("grammar G\nA = \"a\" B\nB = \"b\"\n");
  assert.ok(parsed.success);
  const [first] = parsed.value.items;
  assert.ok(first?.kind === "rule" && first.body.kind === "alts");
  assert.equal(first.body.alts[0]!.elems.length, 2);
});

test("contextual words stay usable as names", () => {
  const parsed = parse("grammar G\nA = left:B atom:C\nB = \"b\"\nC = \"c\"\n");
  assert.ok(parsed.success);
});

test("a syntax error is a diagnostic at its offset", () => {
  const source = "grammar G\nA = (\"a\" | )\n";
  const parsed = parse(source);
  assert.ok(!parsed.success);
  assert.ok(parsed.errors[0].span!.start <= source.indexOf(")"));
});

test("deep nesting is a diagnostic, not a crash", () => {
  const parsed = parse(`grammar G\nA = ${"(".repeat(20_000)}"a"${")".repeat(20_000)}\n`);
  assert.ok(!parsed.success);
  assert.equal(parsed.errors[0].message, "Fatal: input nests too deeply to parse");
});
