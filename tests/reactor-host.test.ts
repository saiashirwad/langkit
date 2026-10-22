import { type Piece, project } from "langkit/host";
import { emitModule } from "langkit/javascript";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { host, program } from "../examples/reactor/reactor-host.ts";
import { checkSource } from "../examples/reactor/reactor.ts";

const player = readFileSync(new URL("../examples/reactor/player.reactor", import.meta.url), "utf8");

const hosted = (source: string) => {
  const result = host.host(source, "file:///main.reactor");
  return { ...result, text: project(result.declarations).text };
};

test("host: a machine projects as its cells, then its signals, then a method per input", () => {
  const { text, diagnostics } = hosted(player);
  assert.deepEqual(diagnostics, []);
  const members = text.slice(text.indexOf("export interface Player {")).split("\n").filter((line) =>
    /^  \w/.test(line)
  );
  assert.deepEqual(members.slice(0, 7), [
    "  readonly root: Root | null;",
    "  readonly shape: Shape | null;",
    "  readonly feel: Feel | null;",
    "  readonly steps: readonly [] | readonly [Step] | readonly [Step, Step] | readonly [Step, Step, Step];",
    "  readonly clip: Clip | null;",
    "  press(value: Root | Shape | Feel): Player;",
    "  bar(): Player;",
  ]);
  assert.ok(text.includes("export declare const Player: {\n"), text);
  assert.ok(text.includes("  start(): Player;\n  /** Parses a stored snapshot"), text);
  assert.ok(text.includes("export type Feel = \"Straight\" | \"Swing\" | \"Half\";\n"), text);
});

test("host: a list bounded past 8, or not at all, projects as a readonly array", () => {
  const source = [
    "type Feel = Straight | Half",
    "machine M {",
    "  input bar",
    "  cell some : [Feel; ..8] = []",
    "  cell many : [Feel; ..9] = []",
    "  cell all : [Feel] = []",
    "}",
    "",
  ].join("\n");
  const { text } = hosted(source);
  assert.ok(text.includes("  readonly some: readonly [] | readonly [Feel] |"), text);
  assert.ok(text.includes(`readonly [${Array(8).fill("Feel").join(", ")}];\n`), text);
  assert.ok(text.includes("  readonly many: readonly Feel[];\n"), text);
  assert.ok(text.includes("  readonly all: readonly Feel[];\n"), text);
});

test("host: every member is verbatim at its declaration, so go-to-definition lands on it", () => {
  const { declarations } = hosted(player);
  const line = (offset: number) => player.slice(player.lastIndexOf("\n", offset) + 1, player.indexOf("\n", offset));
  const at = (name: string) =>
    declarations.flatMap((piece: Piece) =>
      typeof piece !== "string" && piece.text === name ? [line(piece.span.start).trim()] : []
    );
  assert.deepEqual(at("steps"), ["cell steps : [Step; ..3] = []"]);
  assert.equal(at("clip").at(-1), "signal clip : Clip = on press if root, shape, feel -> { root, shape, feel }");
  assert.deepEqual(at("press"), ["input press : Root | Shape | Feel"]);
  assert.deepEqual(at("bar"), ["input bar"]);
  assert.deepEqual(at("Player"), ["machine Player {"]);
});

test("host: a checked file with errors is not hosted", () => {
  const { diagnostics, javascript, text } = hosted(player.replace("last Feel", "last Fel"));
  assert.equal(javascript, undefined);
  assert.equal(text, "");
  assert.deepEqual(diagnostics.map(({ message }) => message), ["Unknown type: Fel"]);
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "reactor-runtime-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

type Value = { readonly [name: string]: unknown; };
type Machine = { readonly start: () => Value; readonly parse: (snapshot: unknown) => Value; };

let modules = 0;
const load = async (source: string, name: string): Promise<Machine> => {
  const checked = checkSource(source);
  assert.ok(checked.success, checked.success ? "" : checked.errors.map(({ message }) => message).join("\n"));
  const file = pathToFileURL(join(scratch, `module-${modules++}.mjs`));
  writeFileSync(file, emitModule(program(file.href, checked.value)));
  return ((await import(file.href)) as Readonly<Record<string, Machine>>)[name]!;
};

const fire = (value: Value, input: string, ...args: readonly unknown[]): Value => {
  const method: unknown = Reflect.get(value, input);
  assert.ok(typeof method === "function", `no input ${input}`);
  return Reflect.apply(method, value, args);
};

const presses = (value: Value, keys: readonly string[]): Value =>
  keys.reduce((current, key) => fire(current, "press", key), value);

const bars = (value: Value, n: number): Value =>
  Array.from({ length: n }).reduce<Value>((current) => fire(current, "bar"), value);

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const clip = (root: string, shape = "Major", feel = "Straight") => ({ root, shape, feel });
const loop = (root: string, feel?: string) => ({ tag: "Loop", clip: clip(root, "Major", feel) });
const strum = (root: string) => ({ tag: "SlowStrum", clip: clip(root) });

const eight = ["I", "Major", "Straight", "Straight", "II", "Straight", "III", "Straight"];

test("runtime: eight presses build three slow strums, one tick per press", async () => {
  const Player = await load(player, "Player");
  const seen = eight.reduce<Value[]>((trail, key) => [...trail, fire(trail.at(-1)!, "press", key)], [Player.start()])
    .map(({ steps }) => json(steps));
  assert.deepEqual(seen, [
    [],
    [],
    [],
    [loop("I")],
    [strum("I")],
    [strum("I"), loop("II")],
    [strum("I"), strum("II")],
    [strum("I"), strum("II"), loop("III")],
    [strum("I"), strum("II"), strum("III")],
  ]);
});

test("runtime: a fourth clip replaces the last step once the queue is full", async () => {
  const Player = await load(player, "Player");
  const full = presses(Player.start(), [...eight, "IV"]);
  assert.deepEqual(json(full.steps), [strum("I"), strum("II"), loop("IV")]);
});

test("runtime: bar drains the queue from the front, then turns a last strum back into a loop", async () => {
  const Player = await load(player, "Player");
  const full = presses(Player.start(), eight);
  const drained = [1, 2, 3, 4].map((n) => json(bars(full, n).steps));
  assert.deepEqual(drained, [
    [strum("II"), strum("III")],
    [strum("III")],
    [loop("III")],
    [loop("III")],
  ]);
});

test("runtime: a Half clip never strums, since the guard refuses the row", async () => {
  const Player = await load(player, "Player");
  const half = presses(Player.start(), ["I", "Major", "Half", "Half"]);
  assert.deepEqual(json(half.steps), [loop("I", "Half"), loop("I", "Half")]);
});

test("runtime: a signal holds the value it took in the last tick, and is absent in every other", async () => {
  const Player = await load(player, "Player");
  const start = Player.start();
  assert.deepEqual(json(start), { root: null, shape: null, feel: null, steps: [], clip: null });
  const two = presses(start, ["I", "Major"]);
  assert.equal(two.clip, null);
  const three = fire(two, "press", "Straight");
  assert.deepEqual(json(three.clip), clip("I"));
  const barred = fire(three, "bar");
  assert.equal(barred.clip, null);
  assert.deepEqual([barred.root, barred.shape, barred.feel], ["I", "Major", "Straight"]);
  assert.deepEqual(json(fire(barred, "press", "Swing").clip), clip("I", "Major", "Swing"));
});

test("runtime: values are deeply frozen and an old value stays as it was", async () => {
  const Player = await load(player, "Player");
  const before = presses(Player.start(), ["I", "Major", "Straight"]);
  const snapshot = JSON.stringify(before);
  const after = fire(before, "press", "Straight");
  assert.equal(JSON.stringify(before), snapshot);
  const steps = after.steps as readonly Value[];
  for (const value of [after, steps, steps[0], steps[0]!.clip, after.clip]) assert.ok(Object.isFrozen(value));
  assert.throws(() => {
    (after as { steps: unknown; }).steps = [];
  }, TypeError);
  assert.deepEqual(json(fire(before, "press", "Straight")), json(after));
});

test("runtime: the snapshot is the cells then the signals, and parse round-trips it", async () => {
  const Player = await load(player, "Player");
  const value = presses(Player.start(), eight.slice(0, 6));
  assert.deepEqual(Object.keys(value), ["root", "shape", "feel", "steps", "clip"]);
  const restored = Player.parse(json(value));
  assert.deepEqual(restored, value);
  assert.deepEqual(json(fire(restored, "press", "III")), json(fire(value, "press", "III")));
});

const refusals: readonly (readonly [claim: string, misuse: (Player: Machine) => unknown, message: RegExp])[] = [
  [
    "a press that is no Root, Shape or Feel",
    (Player) => fire(Player.start(), "press", "Banana"),
    /^Player\.press: expected "I" \| "II" .* \| "Half", found "Banana"$/,
  ],
  [
    "an argument to an input that carries nothing",
    (Player) => fire(Player.start(), "bar", 1),
    /^Player\.bar: takes nothing, found 1$/,
  ],
  [
    "a snapshot longer than the cell's bound",
    (Player) => Player.parse({ steps: [loop("I"), loop("I"), loop("I"), loop("I")] }),
    /^snapshot\.steps: expected at most 3 items, found 4$/,
  ],
  [
    "a snapshot with a bad step",
    (Player) => Player.parse({ steps: [{ tag: "Loop", clip: clip("IX") }] }),
    /^snapshot\.steps\[0\]\.clip\.root: expected "I" \| .*, found "IX"$/,
  ],
  [
    "a snapshot with an unknown field",
    (Player) => Player.parse({ steps: [], mood: 1 }),
    /^snapshot: unexpected field mood$/,
  ],
];

for (const [claim, misuse, message] of refusals) {
  test(`runtime: refuses ${claim} and names the path`, async () => {
    const Player = await load(player, "Player");
    assert.throws(() => misuse(Player), (error: unknown) => error instanceof TypeError && message.test(error.message));
  });
}

test("runtime: an input carrying one type binds it, and a group on a signal reads the signal", async () => {
  const source = [
    "type Note = { pitch : Int }",
    "machine Echo {",
    "  input play : Note",
    "  input clear",
    "  cell note : Note? = last Note",
    "  signal loud : Note = on play if note -> note",
    "  cell heard : [Note; ..2] = []",
    "    on play n",
    "      [a, _] -> [a, n]",
    "      [..] -> [.., n]",
    "    on clear",
    "      [..] -> []",
    "  cell echoes : [Note] = []",
    "    on loud",
    "      [..] -> [.., loud]",
    "}",
    "",
  ].join("\n");
  const Echo = await load(source, "Echo");
  const played = [1, 2, 3].reduce((value, pitch) => fire(value, "play", { pitch }), Echo.start());
  assert.deepEqual(json(played), {
    note: { pitch: 3 },
    heard: [{ pitch: 1 }, { pitch: 3 }],
    echoes: [{ pitch: 1 }, { pitch: 2 }, { pitch: 3 }],
    loud: { pitch: 3 },
  });
  assert.deepEqual(json(fire(played, "clear")), { ...json(played) as object, heard: [], loud: null });
  assert.throws(
    () => fire(played, "play", { pitch: "high" }),
    /^TypeError: Echo\.play\.pitch: expected Int, found "high"$/,
  );
});
