import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { parse as hand } from "../examples/domain/domain-syntax.ts";
import type * as G from "../examples/grammar/domain.grammar";
import { wire } from "../examples/grammar/grammar-model.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { define } from "../examples/grammar/runtime.ts";
import { adapt } from "../tests/grammar-domain-adapter.ts";

const checked = checkSource(readFileSync(new URL("../examples/grammar/domain.grammar", import.meta.url), "utf8"));
assert.ok(checked.success, "domain.grammar must check");
const started = performance.now();
const generated = define(wire(checked.value)).parse;
const defineMs = performance.now() - started;

const directory = new URL("../examples/domain/", import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith(".domain")).map((file) =>
  readFileSync(new URL(file, directory), "utf8")
);
const imports = files.flatMap((file) => file.match(/^import .*$/gm) ?? []);
const bodies = files.map((file) => file.replace(/^import .*$/gm, "")).join("\n");

/** Imports come first in a file, so the input is every import once, then the declarations `copies` times. */
const input = (copies: number): string => `${[...new Set(imports)].join("\n")}\n${bodies.repeat(copies)}`;

const median = (values: readonly number[]): number => values.toSorted((a, b) => a - b)[values.length >> 1]!;
const rounds = 7;

console.log(
  `${cpus().length} cores, load ${loadavg().map((load) => load.toFixed(2)).join(" ")}, define ${
    defineMs.toFixed(2)
  } ms`,
);
for (const copies of [1, 100, 1000]) {
  const source = input(copies);
  const expected = hand(source);
  const actual = generated(source);
  assert.ok(expected.success && actual.success, "both parsers must accept the input");
  assert.deepStrictEqual(adapt(actual.value as G.File), expected.value, "both parsers must build the same tree");
  const declarations = expected.value.declarations.length;
  const repeats = Math.max(2, Math.floor(200 / copies));
  const times = { hand: [] as number[], grammar: [] as number[] };
  for (let round = 0; round < rounds; round++) {
    for (const [name, parse] of [["hand", hand], ["grammar", generated]] as const) {
      for (let warm = 0; warm < 2; warm++) parse(source);
      globalThis.gc?.();
      const begin = performance.now();
      for (let repeat = 0; repeat < repeats; repeat++) {
        const result = parse(source);
        assert.ok(result.success, "every timed parse must succeed");
      }
      times[name].push((performance.now() - begin) / repeats);
    }
  }
  const megabytes = source.length / 1048576;
  const line = (name: keyof typeof times) =>
    `${name} ${median(times[name]).toFixed(2)} ms [${Math.min(...times[name]).toFixed(2)}-${
      Math.max(...times[name]).toFixed(2)
    }] ${(megabytes / (median(times[name]) / 1000)).toFixed(1)} MB/s`;
  console.log(
    `x${copies} ${(source.length / 1024).toFixed(0)} KB, ${declarations} declarations | ${line("hand")} | ${
      line("grammar")
    } | grammar/hand ${(median(times.grammar) / median(times.hand)).toFixed(2)}`,
  );
}
