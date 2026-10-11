import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { version } from "typescript";
import { compile, isolatedProject, root } from "./type-contracts.ts";

export type Metrics = { types: number; instantiations: number; checkSeconds: number; totalSeconds: number; memoryBytes: number };
export function parseMetrics(output: string): Metrics {
  const metric = (label: string, unit: string): number => {
    const match = output.match(new RegExp(`^${label}:\\s+([\\d.]+)${unit}\\s*$`, "m"));
    assert.ok(match, `missing metric ${label}\n${output}`);
    const value = Number(match[1]);
    assert.ok(Number.isFinite(value) && value >= 0, `invalid metric ${label}`);
    return value;
  };
  return { types: metric("Types", ""), instantiations: metric("Instantiations", ""), checkSeconds: metric("Check time", "s"), totalSeconds: metric("Total time", "s"), memoryBytes: metric("Memory used", "K") * 1024 };
}

export function scalingConsumer(count: number): string {
  assert.ok(Number.isInteger(count) && count > 0, "positive descriptor count required");
  const cases = Array.from({ length: count }, (_, index) => `case${index}`);
  return [
    'import { check, pure, sequence } from "langkit";',
    'import type { Value } from "langkit/ir";',
    'import { defineOperation } from "langkit/operations/descriptor";',
    'import { defineDialect } from "langkit/operations/dialect";',
    'import { defineJavaScriptBackend } from "langkit/javascript/operations";',
    'import type { Type } from "langkit/types/rows";',
    'type Field = { readonly name: string; readonly value: Value<Type> };',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'const prove = <T extends true>(): T => true as T;',
    ...cases.flatMap((name) => [
      `type ${name}Node = { readonly kind: "${name}"; readonly fields: readonly Field[] };`,
      `const ${name} = defineOperation<Type, ${name}Node>("${name}", { children: node => node.fields.map(field => field.value), scopedBodies: () => [], references: () => [], map: (node, value) => ({ ...node, fields: node.fields.map(field => ({ ...field, value: value(field.value) })) }) });`,
    ]),
    `const descriptors = { ${cases.join(", ")} };`,
    `prove<Equal<keyof typeof descriptors, ${cases.map((name) => JSON.stringify(name)).join(" | ")}>>();`,
    'export const backend = defineJavaScriptBackend(defineDialect(descriptors), {',
    ...cases.map((name) => `  ${name}: (node, context) => { prove<Equal<typeof node, ${name}Node>>(); return node.fields.map(field => context.expr(field.value, context.depth)).join(", "); },`),
    '});',
    'export const consumer = check(function* () {',
    `  const labels = yield* sequence([${cases.map((name) => `pure("${name}" as const)`).join(", ")}]);`,
    `  prove<Equal<typeof labels, [${cases.map((name) => JSON.stringify(name)).join(", ")} ]>>();`,
    '  return labels;',
    '});',
  ].join("\n");
}

export function profile(): void {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  assert.equal(args.length % 2, 0, "usage: type-profile.ts [--samples N] [--output FILE]");
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    assert.ok(["--samples", "--output"].includes(flag) && !options.has(flag), `invalid flag ${flag}`);
    options.set(flag, args[index + 1]!);
  }
  const samples = Number(options.get("--samples") ?? 3);
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 20, "samples must be 1..20");
  const project = isolatedProject();
  const flags = ["--extendedDiagnostics", "--noEmit", "--composite", "false", "--declaration", "false"];
  const report: {
    compilerVersion: string; nodeVersion: string; revision: string; sourceHash: string; lockfileHash: string; config: unknown; samples: number;
    units: Record<string, string>; flags: string[]; bounds: { types: number; instantiations: number };
    workloads: { name: string; consumerHash?: string; measurements: { metrics: Metrics; elapsedSeconds: number; raw: string }[] }[];
  } = {
    compilerVersion: version, nodeVersion: process.version,
    revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    sourceHash: createHash("sha256").update(["src", "examples", "tests", "tools"].flatMap((directory) => readdirSync(join(root, directory), { recursive: true }).filter((path) => String(path).endsWith(".ts")).map((path) => `${directory}/${path}\n${readFileSync(join(root, directory, String(path)), "utf8")}`)).sort().join("\n")).digest("hex"),
    lockfileHash: createHash("sha256").update(readFileSync(join(root, "pnpm-lock.yaml"))).digest("hex"),
    config: JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")),
    samples, units: { types: "count", instantiations: "count", checkSeconds: "seconds", totalSeconds: "seconds", elapsedSeconds: "seconds", memoryBytes: "bytes" },
    flags: ["--pretty", "false", "--incremental", "false", ...flags], bounds: { types: 500_000, instantiations: 2_000_000 }, workloads: [],
  };
  try {
    for (const size of [0, 10, 50, 200]) {
      const source = size === 0 ? undefined : scalingConsumer(size);
      if (source !== undefined) writeFileSync(join(project.directory, "consumer.ts"), source);
      const workload: typeof report.workloads[number] = { name: size === 0 ? "main" : `${size} typed descriptors + callbacks + yield tuple`, measurements: [], ...(source === undefined ? {} : { consumerHash: createHash("sha256").update(source).digest("hex") }) };
      for (let sample = 0; sample < samples; sample++) {
        const start = performance.now();
        const result = compile(size === 0 ? join(root, "tsconfig.json") : project.config, flags);
        assert.equal(result.status, 0, `${workload.name} failed\n${result.output}`);
        const metrics = parseMetrics(result.output);
        assert.ok(metrics.types > 0 && metrics.instantiations > 0, "profile must measure checking work");
        assert.ok(metrics.types <= report.bounds.types && metrics.instantiations <= report.bounds.instantiations, `${workload.name}: deterministic type cost exceeds bounds`);
        workload.measurements.push({ metrics, elapsedSeconds: (performance.now() - start) / 1000, raw: result.output });
      }
      report.workloads.push(workload);
      const median = (key: keyof Metrics): number => {
        const values = workload.measurements.map((sample) => sample.metrics[key]).sort((a, b) => a - b);
        return (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2;
      };
      console.log(`TS ${version} ${workload.name} (${samples} cold samples, medians): types=${median("types")} instantiations=${median("instantiations")} check=${median("checkSeconds").toFixed(3)}s total=${median("totalSeconds").toFixed(3)}s memory=${median("memoryBytes")} bytes`);
    }
    const output = options.get("--output");
    if (output !== undefined) {
      const file = resolve(output);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`Raw profile: ${file}`);
    }
    console.log(`Type cost gate: <=${report.bounds.types} types and <=${report.bounds.instantiations} instantiations per workload. Timing/memory reported only; machine noise is not gated.`);
  } finally {
    project.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) profile();
