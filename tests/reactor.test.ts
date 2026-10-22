import { definitionAt, typeAt } from "langkit/analysis";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Module } from "../examples/reactor/reactor-model.ts";
import { analyze, checkSource } from "../examples/reactor/reactor.ts";

const player = readFileSync(new URL("../examples/reactor/player.reactor", import.meta.url), "utf8");

const diagnose = (source: string) => {
  const result = checkSource(source);
  return result.success ? [] : result.errors.map(({ message, span }) => ({
    message,
    at: source.slice(span!.start, span!.end),
    line: source.slice(0, span!.start).split("\n").length,
  }));
};

const moduleOf = (source: string): Module => {
  const result = checkSource(source);
  assert.ok(result.success, result.success ? "" : result.errors.map(({ message }) => message).join("\n"));
  return result.value;
};

const base = [
  "type Root = I | II",
  "type Feel = Straight | Half",
  "type Clip = { root : Root, feel : Feel }",
  "machine M {",
  "  input press : Root | Feel",
  "  input bar",
  "  cell root : Root? = last Root",
  "  cell feel : Feel? = last Feel",
  "  signal clip : Clip = on press if root, feel -> { root, feel }",
  "}",
  "",
].join("\n");

/** Appends an item to the machine's body. */
const inside = (item: string, source = base) => source.replace(/}\n$/, `  ${item}\n}\n`);

const edit = (original: string, replacement: string, source = base) => {
  assert.ok(source.includes(original), `${JSON.stringify(original)} is not in the source`);
  return source.replace(original, replacement);
};

type Case = {
  readonly rule: string;
  readonly source: string;
  readonly message: string;
  readonly at: string;
  readonly line: number;
};

const cases: readonly Case[] = [
  {
    rule: "an unknown type",
    source: inside("cell n : Missing? = last Missing"),
    message: "Unknown type: Missing",
    at: "Missing",
    line: 10,
  },
  {
    rule: "a repeated top-level name",
    source: `type Root = A\n${base}`,
    message: "Duplicate declaration: Root",
    at: "Root",
    line: 2,
  },
  {
    rule: "a repeated machine name",
    source: inside("cell root : Root? = last Root"),
    message: "Duplicate declaration: root",
    at: "root",
    line: 10,
  },
  {
    rule: "a cell named like a constructor",
    source: inside("cell Half : Feel? = last Feel"),
    message: "Half is a member of Feel; a cell cannot take its name",
    at: "Half",
    line: 10,
  },
  {
    rule: "two enums of one input union share a member",
    source: edit("input press : Root | Feel", "input press : Root | Feel | Mood", `type Mood = Calm | Half\n${base}`),
    message: "Half is in both Feel and Mood, so press could not tell them apart",
    at: "Mood",
    line: 6,
  },
  {
    rule: "an input union of something other than enums",
    source: edit("input press : Root | Feel", "input press : Root | Feel | Clip"),
    message: "An input union joins enums; Clip is a record",
    at: "Clip",
    line: 5,
  },
  {
    rule: "an input union carrying one type twice",
    source: edit("input press : Root | Feel", "input press : Root | Feel | Root"),
    message: "press carries Root twice",
    at: "Root",
    line: 5,
  },
  {
    rule: "an input carrying an optional",
    source: inside("input tap : Root?"),
    message: "An input always carries a value; drop the ? from Root?",
    at: "Root?",
    line: 10,
  },
  {
    rule: "last of a type no input carries",
    source: inside("cell shape : Shape? = last Shape", `type Shape = Major | Minor\n${base}`),
    message: "No input carries Shape",
    at: "Shape",
    line: 11,
  },
  {
    rule: "last of a type two inputs carry",
    source: edit("input bar", "input tap : Root"),
    message: "press and tap carry Root; last needs exactly one input carrying it",
    at: "Root",
    line: 7,
  },
  {
    rule: "a last cell that is not optional",
    source: edit("cell root : Root? = last Root", "cell root : Root = last Root"),
    message: "A last Root cell is Root?, not Root",
    at: "Root",
    line: 7,
  },
  {
    rule: "an optional cell read outside an if",
    source: edit("if root, feel", "if root"),
    message: "feel may be absent here; only a signal's if makes it present",
    at: "feel",
    line: 9,
  },
  {
    rule: "a value of the wrong type",
    source: edit("{ root, feel }", "{ root = feel, feel }"),
    message: "Clip.root is Root, but this is Feel",
    at: "feel",
    line: 9,
  },
  {
    rule: "an if naming a cell that is never absent",
    source: inside("cell n : [Root; ..2] = []", edit("if root, feel", "if root, feel, n")),
    message: "n is never absent; drop it from if",
    at: "n",
    line: 9,
  },
  {
    rule: "an if naming a signal",
    source: inside("signal echo : Clip = on press if clip -> clip"),
    message: "clip is a signal; if lists optional cells",
    at: "clip",
    line: 10,
  },
  {
    rule: "an if naming a cell twice",
    source: edit("if root, feel", "if root, feel, root"),
    message: "root is listed twice",
    at: "root",
    line: 9,
  },
  {
    rule: "a signal firing on a cell",
    source: edit("on press if", "on root if"),
    message: "clip fires on an input; root is a cell",
    at: "root",
    line: 9,
  },
  {
    rule: "an input read as a value",
    source: edit("{ root, feel }", "{ root = press, feel }"),
    message: "press is an input, not a value",
    at: "press",
    line: 9,
  },
  {
    rule: "an initial value reading a cell",
    source: inside("cell first : Root? = root"),
    message: "An initial value is fixed before any tick, so it cannot read root",
    at: "root",
    line: 10,
  },
  {
    rule: "an initial value longer than its cell's bound",
    source: inside("cell n : [Root; ..1] = [I, II]"),
    message: "n holds at most 1, but this value can make it hold 2",
    at: "[I, II]",
    line: 10,
  },
  {
    rule: "a record literal missing a field",
    source: edit("{ root, feel }", "{ root }"),
    message: "Clip needs feel : Feel",
    at: "{ root }",
    line: 9,
  },
  {
    rule: "a record literal with an unknown field",
    source: edit("{ root, feel }", "{ root, feel, mood = Half }"),
    message: "Clip has no field mood",
    at: "mood",
    line: 9,
  },
  {
    rule: "a record literal repeating a field",
    source: edit("{ root, feel }", "{ root, feel, root = I }"),
    message: "Duplicate field: Clip.root",
    at: "root",
    line: 9,
  },
  {
    rule: "a constructor of another type",
    source: inside("cell n : [Root; ..1] = [Half]"),
    message: "Half is a member of Feel, not Root",
    at: "Half",
    line: 10,
  },
  {
    rule: "an unknown name",
    source: edit("{ root, feel }", "{ root = rot, feel }"),
    message: "Unknown name: rot",
    at: "rot",
    line: 9,
  },
  {
    rule: "a bound of zero",
    source: inside("cell n : [Root; ..0] = []"),
    message: "A bounded list holds at least one element",
    at: "..0",
    line: 10,
  },
  {
    rule: "a type that contains itself",
    source: `type Tree = Leaf | Node(kids : [Tree])\n${base}`,
    message: "Reactor state must be finite: Tree contains itself",
    at: "Tree",
    line: 1,
  },
  {
    rule: "types that contain each other",
    source: `type A = { b : B? }\ntype B = { a : [A; ..2] }\n${base}`,
    message: "Reactor state must be finite: A contains itself, through B",
    at: "A",
    line: 1,
  },
];

for (const { rule, source, message, at, line } of cases) {
  test(`reactor reports ${rule}`, () => {
    assert.deepEqual(diagnose(source), [{ message, at, line }]);
  });
}

test("player.reactor checks clean", () => {
  const machine = moduleOf(player).machines[0]!;
  assert.deepEqual(machine.inputs.map(({ name }) => name.name), ["press", "bar"]);
});

test("a typo in a cell's type is one error, not one per read", () => {
  const source = inside("signal echo : Root = on press if n -> n", inside("cell n : Rot? = last Rot"));
  assert.deepEqual(diagnose(source), [{ message: "Unknown type: Rot", at: "Rot", line: 10 }]);
});

test("hover shows inputs, signals, types and a cell narrowed inside its if", () => {
  const analysis = analyze(player);
  const hover = (text: string, from = 0) => typeAt(analysis, player.indexOf(text, from))?.type;
  assert.deepEqual(analysis.diagnostics, []);
  assert.equal(hover("press :"), "input press : Root | Shape | Feel");
  assert.equal(hover("clip :", player.indexOf("signal")), "signal clip : Clip");
  assert.equal(hover("root  :"), "cell root : Root?");
  const arrow = player.indexOf("-> { root");
  assert.equal(hover("root", arrow), "root : Root");
  assert.equal(hover("Clip =", player.indexOf("signal")), "type Clip = { root : Root, shape : Shape, feel : Feel }");
  assert.equal(hover("Step; ..3"), "type Step = Loop(clip : Clip) | SlowStrum(clip : Clip)");
  const read = player.indexOf("root", arrow);
  assert.equal(definitionAt(analysis, read)?.span.start, player.indexOf("root  :"));
});
