import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const compiler = resolve(root, "node_modules/typescript/bin/tsc");
export function fragment(source: string, text: string): { index: number; text: string; } {
  const pattern = [...text.replace(/\s/g, "")].map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  const matches = [...source.matchAll(new RegExp(pattern, "g"))];
  assert.equal(matches.length, 1, `fragment must match once: ${text}`);
  return { index: matches[0]!.index, text: matches[0]![0] };
}
export function compile(config: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [
    compiler,
    "-p",
    config,
    "--pretty",
    "false",
    "--incremental",
    "false",
    "--runExternalCode",
    ...extra,
  ], { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `compiler terminated: ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

export function isolatedProject(
  files: readonly string[] = ["consumer.ts"],
): { directory: string; config: string; dispose: () => void; } {
  const directory = mkdtempSync(join(root, ".tooling-contract-"));
  try {
    cpSync(join(root, "src"), join(directory, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(directory, "package.json"));
    symlinkSync(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    const config = join(directory, "tsconfig.json");
    writeFileSync(
      config,
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: { composite: false, incremental: false },
        files,
        include: [],
        exclude: [],
      }),
    );
    return { directory, config, dispose: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function runContracts(): void {
  const fixture = readFileSync(join(root, "tests/editor-consumer.ts"), "utf8");
  const project = isolatedProject();
  try {
    const file = join(project.directory, "consumer.ts");
    writeFileSync(file, fixture);
    const baseline = compile(project.config);
    assert.equal(baseline.status, 0, `baseline failed\n${baseline.output}`);
    console.log("Compiler corpus: clean isolated baseline (package self-reference and pnpm dependencies resolved)");
    const controls = [
      {
        name: "yielded",
        original: "pure(\"ready\" as const)",
        replacement: (type: string) => type === "any" ? "pure<any>(\"ready\")" : "pure<never>(undefined as never)",
        proof: "prove<Equal<typeof yielded, \"ready\">>();",
      },
      {
        name: "synthesized",
        original: "judgments.synth({ kind: \"number\", value: 42 })",
        replacement: (type: string) => `pure<${type}>(undefined as ${type})`,
        proof: "prove<Equal<typeof synthesized, Synthesized<AuthorType, AuthorTerm>>>();",
      },
      {
        name: "variable",
        original: "const variable = yield* hm.fresh()",
        replacement: (type: string) => `const variable = undefined as ${type}`,
        proof: "prove<Equal<typeof variable, hm.Variable>>();",
      },
    ];
    for (const control of controls) {
      const seed = fragment(fixture, control.original);
      for (const type of ["any", "never"] as const) {
        const source = fixture.slice(0, seed.index) + control.replacement(type)
          + fixture.slice(seed.index + seed.text.length);
        writeFileSync(file, source);
        const result = compile(project.config);
        assert.notEqual(result.status, 0, `${type} control must fail\n${result.output}`);
        const locations = [
          control.proof,
          `prove<Equal<${type === "any" ? "IsAny" : "IsNever"}<typeof ${control.name}>, false>>();`,
        ];
        const expected = locations.map((location) => {
          const proof = fragment(source, location);
          const argument = source.indexOf("Equal", proof.index);
          return `${file}:${source.slice(0, argument).split("\n").length}:TS2344`;
        }).sort();
        const actual = [...result.output.matchAll(/^(?:(.+)\((\d+),\d+\): )?error TS(\d+):/gm)].map((match) =>
          `${match[1] ? resolve(root, match[1]) : "<global>"}:${match[2] ?? 0}:TS${match[3]}`
        ).sort();
        assert.deepEqual(actual, expected, `${type} control failed for unintended reasons\n${result.output}`);
        console.log(
          `Compiler ${control.name} ${type} mutant rejected: ${
            expected.map((item) => item.replace(`${project.directory}/`, "")).join(", ")
          }`,
        );
      }
    }
  } finally {
    project.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runContracts();
