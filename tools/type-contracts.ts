import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const compiler = resolve(root, "node_modules/typescript/bin/tsc");
export function compile(config: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, [compiler, "-p", config, "--pretty", "false", "--incremental", "false", ...extra], { cwd: root, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, `compiler terminated: ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

export function isolatedProject(): { directory: string; config: string; dispose: () => void } {
  const directory = mkdtempSync(join(root, ".tooling-contract-"));
  try {
    cpSync(join(root, "src"), join(directory, "src"), { recursive: true });
    cpSync(join(root, "package.json"), join(directory, "package.json"));
    symlinkSync(resolve(root, "node_modules"), join(directory, "node_modules"), "dir");
    const config = join(directory, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions: { composite: false, incremental: false }, files: ["consumer.ts"], include: [], exclude: [] }));
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
    const original = 'pure("ready" as const)';
    assert.equal(fixture.split(original).length, 2, "mutation seed must match once");
    for (const type of ["any", "never"] as const) {
      const source = fixture.replace(original, type === "any" ? 'pure<any>("ready")' : "pure<never>(undefined as never)");
      writeFileSync(file, source);
      const result = compile(project.config);
      assert.equal(result.status, 1, `${type} control must fail\n${result.output}`);
      const locations = [
        'prove<Equal<typeof yielded, "ready">>();',
        `prove<Equal<${type === "any" ? "IsAny" : "IsNever"}<typeof yielded>, false>>();`,
      ];
      const expected = locations.map((location) => {
        assert.equal(source.split(location).length, 2, "proof anchor must match once");
        return `${file}:${source.slice(0, source.indexOf(location)).split("\n").length}:TS2344`;
      }).sort();
      const actual = [...result.output.matchAll(/^(?:(.+)\((\d+),\d+\): )?error TS(\d+):/gm)].map((match) => `${match[1] ? resolve(root, match[1]) : "<global>"}:${match[2] ?? 0}:TS${match[3]}`).sort();
      assert.deepEqual(actual, expected, `${type} control failed for unintended reasons\n${result.output}`);
      console.log(`Compiler ${type} mutant rejected: ${expected.map((item) => item.replace(`${project.directory}/`, "")).join(", ")}`);
    }
  } finally {
    project.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runContracts();
