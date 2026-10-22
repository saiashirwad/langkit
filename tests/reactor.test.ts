import { definitionAt, semanticTokens, typeAt } from "langkit/analysis";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

const moduleOf = (source: string) => {
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
  {
    rule: "a list pattern on a value that is not a list",
    source: inside("cell mode : Feel = Straight\n    on bar\n      [x] -> Half"),
    message: "A list pattern matches a list, not Feel",
    at: "[x]",
    line: 12,
  },
  {
    rule: "a variant pattern with the wrong number of arguments",
    source: edit("[.., Loop(c)]        ->", "[.., Loop(c, c)]     ->", player),
    message: "Loop takes 1 argument, but this gives 2",
    at: "(c, c)",
    line: 21,
  },
  {
    rule: "a pattern constructor of another type",
    source: edit("[SlowStrum(c)]       ->", "[Half]               ->", player),
    message: "Half is a member of Feel, not Step",
    at: "Half",
    line: 28,
  },
  {
    rule: "a bound name compared with a value of another type",
    source: edit("[a, b, _]            ->  [a, b, Loop(c)]", "[a, b, c]            ->  [a, b, Loop(c)]", player),
    message: "c is Clip, so it never equals a Step",
    at: "c",
    line: 23,
  },
  {
    rule: "a list pattern with two spreads",
    source: edit("[_, x, ..]           ->", "[..x, ..s]           ->", player),
    message: "A list pattern spreads at most once",
    at: "..s",
    line: 27,
  },
  {
    rule: "a spread over a name already bound",
    source: edit("[..]                 ->  [.., Loop(c)]", "[..c]                ->  [..c, Loop(c)]", player),
    message: "c is already bound; a spread binds a fresh name",
    at: "c",
    line: 24,
  },
  {
    rule: "a bare .. in a row whose pattern has no ..",
    source: edit("[a, b, _]            ->  [a, b, Loop(c)]", "[a, b, _]            ->  [.., Loop(c)]", player),
    message: "`..` carries the rest a row's pattern matched, but this pattern has none",
    at: "..",
    line: 23,
  },
  {
    rule: "a bare .. in a signal value",
    source: inside("signal all : [Root; ..2] = on bar -> [..]"),
    message: "There is no row pattern for this `..` to carry the rest of",
    at: "..",
    line: 10,
  },
  {
    rule: "a bare .. in a cell's initial value",
    source: edit("cell steps : [Step; ..3] = []", "cell steps : [Step; ..3] = [..]", player),
    message: "There is no row pattern for this `..` to carry the rest of",
    at: "..",
    line: 18,
  },
  {
    rule: "a row the rows above already cover",
    source: edit(
      "[_, x, ..]           ->  [x, ..]",
      "[_, x, ..]           ->  [x, ..]\n      [x, y, z]            ->  [x, y, z]",
      player,
    ),
    message: "This row never fires; the rows above already take every value it matches",
    at: "[x, y, z]",
    line: 28,
  },
  {
    rule: "an on group naming a cell",
    source: edit("on bar", "on feel", player),
    message: "feel is a cell; on takes an input or a signal",
    at: "feel",
    line: 26,
  },
  {
    rule: "a binder on an input that carries nothing",
    source: edit("on bar", "on bar b", player),
    message: "bar carries nothing to bind",
    at: "b",
    line: 26,
  },
  {
    rule: "a binder on an input that carries a union",
    source: edit("on bar", "on press p", player),
    message: "press carries Root | Shape | Feel; read it through a last cell",
    at: "p",
    line: 26,
  },
  {
    rule: "an unbounded spread into a bounded cell",
    source: edit(
      "  property halfNeverStrums",
      "  signal all : [Step] = on bar -> []\n  cell copy : [Step; ..3] = []\n    on all xs\n      [..s] -> [..xs]\n  property halfNeverStrums",
      player,
    ),
    message: "copy holds at most 3, but this row can make it hold any number",
    at: "[..xs]",
    line: 33,
  },
  {
    rule: "a guard testing against a constructor of another type",
    source: edit("unless c.feel is Half", "unless c.feel is Loop", player),
    message: "Loop is a variant of Step, not Feel",
    at: "Loop",
    line: 21,
  },
  {
    rule: "a property pattern with an unknown field",
    source: edit("{ feel = Half }", "{ mood = Half }", player),
    message: "Clip has no field mood",
    at: "mood",
    line: 30,
  },
  {
    rule: "a property reading a signal",
    source: inside("property p = never (clip is { feel = Half })"),
    message: "clip is a signal, which is not state; a property reads cells",
    at: "clip",
    line: 10,
  },
  {
    rule: "a property testing a cell that may be absent",
    source: inside("property p = never (root is I)"),
    message: "root may be absent here, and is cannot test an absent value yet",
    at: "root",
    line: 10,
  },
  {
    rule: "contains on a value that is not a list",
    source: inside("property p = possible (mode contains Half)", inside("cell mode : Feel = Straight")),
    message: "contains tests a list, but mode is Feel",
    at: "mode",
    line: 11,
  },
  {
    rule: "a repeated property name",
    source: inside(
      "property p = possible (not (mode is Half))",
      inside("property p = never (mode is Half)", inside("cell mode : Feel = Straight")),
    ),
    message: "Duplicate property: p",
    at: "p",
    line: 12,
  },
  {
    rule: "a cell and a signal that read each other",
    source: inside(
      "signal ping : [Root; ..2] = on bar -> a",
      inside("cell a : [Root; ..2] = []\n    on ping p\n      [..s] -> p"),
    ),
    message: "Causality cycle: a reads ping, which reads a",
    at: "ping",
    line: 11,
  },
  {
    rule: "an input TypeScript cannot carry as a method",
    source: inside("input then"),
    message: "TypeScript cannot represent then, an input name",
    at: "then",
    line: 10,
  },
  {
    rule: "a cell TypeScript cannot carry as a property",
    source: inside("cell __proto__ : Feel = Straight"),
    message: "TypeScript cannot represent __proto__, a cell name",
    at: "__proto__",
    line: 10,
  },
  {
    rule: "a signal read outside its own group",
    source: inside("cell held : [Clip] = []\n    on bar\n      [..] -> [.., clip]"),
    message: "clip may be absent here; read it inside on clip",
    at: "clip",
    line: 12,
  },
  {
    rule: "a cell reading itself in its rows",
    source: inside("cell a : [Root; ..2] = []\n    on bar\n      [..s] -> a"),
    message: "a reads itself in the same tick; match on its value in a row instead",
    at: "a",
    line: 12,
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

test("a signal is present in the rows of its own group", () => {
  const source = inside("cell held : [Clip] = []\n    on clip\n      [..] -> [.., clip]");
  assert.deepEqual(diagnose(source), []);
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

test("a cell's list bound counts the rows above: without [a, b, _], [..s] can overflow", () => {
  const broken = edit("      [a, b, _]            ->  [a, b, Loop(c)]\n", "", player);
  assert.deepEqual(diagnose(broken), [{
    message: "steps holds at most 3, but this row can make it hold 4",
    at: "[.., Loop(c)]",
    line: 23,
  }]);
});

test("a named rest hovers and resolves like an anonymous one", () => {
  const source = edit("[..]                 ->  [.., Loop(c)]", "[..s]                ->  [..s, Loop(c)]", player);
  const analysis = analyze(source);
  assert.deepEqual(analysis.diagnostics, []);
  const rest = source.indexOf("[..s]  ") + 3;
  assert.equal(typeAt(analysis, rest)?.type, "s : [Step; ..2]");
  const use = source.indexOf("[..s, Loop(c)]") + 3;
  assert.equal(typeAt(analysis, use)?.type, "s : [Step; ..2]");
  assert.equal(definitionAt(analysis, use)?.span.start, rest);
});

test("hover shows a pattern's bindings, a rest narrowed by the rows above, and a binder at its uses", () => {
  const analysis = analyze(player);
  const at = (text: string, from = 0) => player.indexOf(text, from);
  const hover = (offset: number) => typeAt(analysis, offset)?.type;
  const restRow = at("[..]  ");
  assert.equal(hover(restRow + 1), ".. : [Step; ..2]");
  assert.equal(hover(at("[.., Loop(c)]") + 1), ".. : [Step; ..2]");
  assert.equal(hover(at("[_, x, ..]") + 8), ".. : [Step; ..1]");
  assert.equal(hover(at("[.., Loop(c)]", restRow) + 1), ".. : [Step; ..2]");
  const carried = at("[x, ..]") + 4;
  assert.equal(hover(carried), ".. : [Step; ..1]");
  assert.equal(definitionAt(analysis, carried)?.span.start, at("[_, x, ..]") + 7);
  assert.equal(hover(at("on clip c") + 8), "c : Clip");
  const use = at("Loop(c)") + 5;
  assert.equal(hover(use), "c : Clip");
  assert.equal(definitionAt(analysis, use)?.span.start, at("on clip c") + 8);
  assert.equal(hover(at("Half", at("unless"))), "Feel");
  assert.equal(hover(at("feel is", at("unless"))), "feel : Feel");
});

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Item = "x" | "A" | "B";
type Shape = {
  readonly head: readonly Item[];
  readonly spread: boolean;
  readonly tail: readonly Item[];
  readonly grow: number;
};

const firstMatch = (rows: readonly Shape[], list: readonly Item[]): number => {
  const fits = (items: readonly Item[], values: readonly Item[]) =>
    items.every((item, i) => item === "x" || item === values[i]);
  return rows.findIndex(({ head, spread, tail }) =>
    spread
      ? list.length >= head.length + tail.length && fits(head, list)
        && fits(tail, list.slice(list.length - tail.length))
      : list.length === head.length && fits(head, list)
  );
};

/** Every list over A and B up to `max` long. */
const lists = (max: number): readonly (readonly Item[])[] => {
  const all: Item[][] = [[]];
  for (const list of all) if (list.length < max) all.push([...list, "A"], [...list, "B"]);
  return all;
};

const source = (max: number, rows: readonly Shape[]): string => {
  const row = ({ head, spread, tail, grow }: Shape, index: number) => {
    const names = (items: readonly Item[], prefix: string) =>
      items.map((item, i) => item === "x" ? `${prefix}${index}${i}` : item);
    const [h, t] = [names(head, "h"), names(tail, "t")];
    const rest = index % 2 ? `..s${index}` : "..";
    const pattern = [...h, ...spread ? [rest] : [], ...t];
    const value = [...h, ...spread ? [rest] : [], ...t, ...Array<string>(grow).fill("A")];
    return `      [${pattern.join(", ")}] -> [${value.join(", ")}]`;
  };
  return [
    "type E = A | B",
    "machine M {",
    "  input bar",
    `  cell xs : [E; ..${max}] = []`,
    "    on bar",
    ...rows.map(row),
    "}",
    "",
  ]
    .join("\n");
};

test("list-length narrowing agrees with running every list through the rows", () => {
  const next = random(7);
  const pick = <A>(options: readonly A[]): A => options[Math.floor(next() * options.length)]!;
  let exact = 0;
  for (let trial = 0; trial < 400; trial++) {
    const max = pick([1, 2, 3]);
    const refutable = trial % 2 === 1;
    const items = (count: number) =>
      Array.from({ length: count }, () => refutable ? pick<Item>(["x", "x", "A", "B"]) : "x");
    const rows = Array.from({ length: pick([1, 2, 3, 4]) }, (): Shape => {
      const spread = next() < 0.5;
      return { head: items(pick([0, 1, 2])), spread, tail: spread ? items(pick([0, 1])) : [], grow: pick([0, 1]) };
    });
    const firing = rows.map(() => [] as number[]);
    for (const list of lists(max)) {
      const row = firstMatch(rows, list);
      if (row >= 0) firing[row]!.push(list.length);
    }
    const claimed = diagnose(source(max, rows)).map(({ message, line }) =>
      `${line - 6}: ${message.startsWith("This row never fires") ? "never" : "overflow"}`
    );
    const truth = rows.flatMap((row, index) => {
      const lengths = firing[index]!;
      if (!lengths.length) return [`${index}: never`];
      return Math.max(...lengths) + row.grow > max ? [`${index}: overflow`] : [];
    });
    if (refutable) {
      for (const finding of truth.filter((finding) => finding.endsWith("overflow"))) {
        assert.ok(claimed.includes(finding), `${source(max, rows)}\nmissed ${finding}`);
      }
      for (const finding of claimed.filter((finding) => finding.endsWith("never"))) {
        assert.ok(truth.includes(finding), `${source(max, rows)}\nwrongly claimed ${finding}`);
      }
    } else {
      assert.deepEqual(claimed, truth, source(max, rows));
      exact++;
    }
  }
  assert.equal(exact, 200);
});

test("a machine's nodes come after every node they read, whatever order they are written in", () => {
  const signal = "  signal clip : Clip = on press if root, shape, feel -> { root, shape, feel }\n";
  const reordered = edit(signal, "", player).replace(
    "  property halfNeverStrums",
    `${signal}  property halfNeverStrums`,
  );
  for (const source of [player, reordered]) {
    const order = moduleOf(source).machines[0]!.nodes.map(({ slot }) => slot.name.name);
    assert.deepEqual(order.toSorted(), ["clip", "feel", "root", "shape", "steps"]);
    for (const cell of ["root", "shape", "feel"]) {
      assert.ok(order.indexOf(cell) < order.indexOf("clip"), order.join(" "));
    }
    assert.ok(order.indexOf("clip") < order.indexOf("steps"), order.join(" "));
  }
});

test("semantic tokens tell inputs, cells, signals, members and keywords apart", () => {
  const tokens = semanticTokens(analyze(player));
  const kind = (text: string, from = 0) => tokens.find(({ span }) => span.start === player.indexOf(text, from))?.kind;
  assert.equal(kind("press :"), "method");
  assert.equal(kind("press if"), "method");
  assert.equal(kind("steps :"), "property");
  assert.equal(kind("clip :", player.indexOf("signal")), "function");
  assert.equal(kind("clip c"), "function");
  assert.equal(kind("Half", player.indexOf("unless")), "enumMember");
  assert.equal(kind("unless"), "keyword");
  assert.equal(kind("..3"), "operator");
});

test("cli: pnpm reactor summarizes a clean file, and prints the overflow and fails on the broken one", () => {
  const directory = mkdtempSync(join(tmpdir(), "reactor-"));
  try {
    const script = fileURLToPath(new URL("../examples/reactor/reactor.ts", import.meta.url));
    writeFileSync(join(directory, "player.reactor"), player);
    writeFileSync(
      join(directory, "broken.reactor"),
      edit("      [a, b, _]            ->  [a, b, Loop(c)]\n", "", player),
    );
    const cli = (name: string) => spawnSync(process.execPath, [script, name], { cwd: directory, encoding: "utf8" });
    const passing = cli("player.reactor");
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(
      passing.stdout,
      "Player: 2 inputs, 4 cells, 1 signal, 3 properties (properties are not model checked yet)\n",
    );
    const failing = cli("broken.reactor");
    assert.equal(failing.status, 1);
    assert.equal(failing.stdout, "");
    assert.equal(
      failing.stderr,
      [
        "broken.reactor line 23, column 32: steps holds at most 3, but this row can make it hold 4",
        "      [..]                 ->  [.., Loop(c)]",
        "                               ^^^^^^^^^^^^^",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("outside examples/reactor, only reactor.ts, reactor-host.ts and .reactor files are imported", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = (directory: string): readonly string[] =>
    readdirSync(join(root, directory)).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(join(root, path)).isDirectory()) {
        return name === "node_modules" || path === "examples/reactor"
          ? []
          : files(path);
      }
      return name.endsWith(".ts") ? [path] : [];
    });
  const reaching = ["src", "examples", "tests", "tools", "content-mapper"].flatMap(files).flatMap((path) =>
    [...readFileSync(join(root, path), "utf8").matchAll(/from "([^"]*reactor\/[^"]*)"/g)].map(([, specifier]) =>
      `${path}: ${specifier}`
    )
  );
  const surface = ["reactor/reactor.ts", "reactor/reactor-host.ts", ".reactor"];
  assert.deepEqual(reaching.filter((use) => !surface.some((file) => use.endsWith(file))), []);
  assert.ok(reaching.length > 0);
});
