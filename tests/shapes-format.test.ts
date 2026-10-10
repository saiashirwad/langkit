import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { typeAt } from "langkit/analysis";
import { analyze, show as editorShow } from "../examples/shapes/shapes.ts";
import { fn, fresh, freshRow, number, record, row, show, string } from "../examples/shapes/shapes-types.ts";

const large = record(row(new Map([
  ["alpha", string], ["bravo", string], ["charlie", string],
  ["delta", string], ["echo", string], ["foxtrot", string],
])));
const fits = (value: string) => assert.ok(value.split("\n").every(line => line.length <= 80), value);

test("Shapes keeps short types and higher-order grouping compact", () => {
  assert.equal(show(fn(fn(number, string), number)), "((number -> string) -> number)");
  assert.equal(show(record(row())), "{}");
  assert.equal(show(fn(fresh(), fresh())), "(a -> b)");
});

test("Shapes indents nested records without dropping fields", () => {
  assert.equal(show(record(row(new Map([["nested", large]])))), `{
  nested: {
    alpha: string,
    bravo: string,
    charlie: string,
    delta: string,
    echo: string,
    foxtrot: string
  }
}`);
});

test("Shapes multiline arrows preserve higher-order parameter grouping", () => {
  const displayed = show(fn(fn(large, number), fn(string, large)));
  assert.ok(displayed.startsWith("(\n  {\n"), displayed);
  assert.ok(displayed.includes("\n  } -> number\n) ->\nstring ->\n{"), displayed);
  fits(displayed);
});

test("Shapes prints every row constraint separately and wraps long label lists", () => {
  const labels = Array.from({ length: 16 }, (_, i) => `field${String(i).padStart(2, "0")}`);
  const first = freshRow(labels);
  const second = freshRow(["extra"]);
  const value = fn(record(row(new Map(), first)), record(row(new Map(), second)));
  const displayed = show(value);
  assert.match(displayed, /\nwhere\n  r lacks field00,/);
  assert.match(displayed, /\n  r1 lacks extra$/);
  for (const label of labels) assert.equal(displayed.split(label).length - 1, 1);
  fits(displayed);
  assert.equal(show(value), displayed);
});

test("Shapes does not truncate indivisible long labels", () => {
  const label = "x".repeat(100);
  assert.ok(show(record(row(new Map([[label, number]])))).includes(`${label}: number`));
});

test("Shapes macro hover puts multiline expanded types below their heading", () => {
  const displayed = editorShow({ kind: "macro", name: "keep", params: ["value"], result: large });
  assert.ok(displayed.includes("\nExpanded result:\n{\n"), displayed);
  assert.ok(displayed.endsWith(show(large)));
  fits(displayed);
});

test("Shapes orders pay hover retains nested fields and omits implied row constraints", () => {
  const source = readFileSync(new URL("../examples/shapes/orders.shapes", import.meta.url), "utf8");
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const type = typeAt(analysis, source.indexOf('(pay "') + 1)!.type;
  const displayed = editorShow(type);
  assert.ok(displayed.startsWith("string ->\nPayable & {\n"), displayed);
  assert.ok(displayed.includes("Customer & { member: boolean, ..r }"));
  for (const field of ["member", "customer", "lines", "first", "second", "subtotal", "shipping", "total", "payment", "amount", "reference", "settled"])
    assert.ok(displayed.includes(`${field}:`), field);
  assert.ok(!displayed.includes("where"), displayed);
  assert.ok(displayed.includes("first: PricedLine & { ..r1 }"));
  assert.ok(displayed.includes("second: PricedLine & { ..r2 }"));
  for (const tail of ["..r", "..r1", "..r2", "..r3", "..r4"]) assert.ok(displayed.includes(tail));
  fits(displayed);
  assert.equal(editorShow(type), displayed);
});

test("Shapes keeps short arrow tails beside multiline record closings", () => {
  const displayed = show(fn(large, fn(number, number)));
  assert.ok(displayed.endsWith("} -> number -> number"), displayed);
  fits(displayed);
});

test("Shapes omits only constraints implied by the same visible tail", () => {
  const shared = freshRow(["x", "y", "secret"]);
  const left = record(row(new Map([["x", number]]), shared));
  const right = record(row(new Map([["y", string]]), shared));
  assert.equal(show(fn(left, right)), "({ x: number, ..r } -> { y: string, ..r }) where r lacks secret");
  assert.deepEqual([...shared.lacks], ["x", "y", "secret"]);
  const unrelated = freshRow(["x"]);
  const separate = show(fn(left, record(row(new Map(), unrelated))));
  assert.match(separate, /r lacks secret, y; r1 lacks x$/);
});

test("Shapes retains input-only absence constraints and removes wholly implied ones", () => {
  const tail = freshRow(["active"]);
  assert.equal(show(fn(record(row(new Map(), tail)), number)), "({ ..r } -> number) where r lacks active");
  assert.equal(show(record(row(new Map([["active", number]]), tail))), "{ active: number, ..r }");
});

test("Shapes shippingCost hover uses the compact tail and annotation row syntax", () => {
  const source = readFileSync(new URL("../examples/shapes/orders.shapes", import.meta.url), "utf8");
  const analysis = analyze(source);
  const displayed = editorShow(typeAt(analysis, source.indexOf("shippingCost"))!.type);
  assert.equal(displayed, "(Customer & { member: boolean } -> (number -> number))");
});

test("Shapes wraps long arrow tails without losing higher-order parentheses", () => {
  const callback = fn(number, string);
  const displayed = show(fn(large, fn(callback, fn(large, number))));
  assert.ok(displayed.includes("(number -> string) ->"), displayed);
  assert.ok(displayed.endsWith("} -> number"), displayed);
  fits(displayed);
});
