import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compile, isolatedProject, root } from "../tools/type-contracts.ts";

for (
  const document of [
    "README.md",
    "docs/inference-theories.md",
    "docs/compiler-authoring.md",
  ]
) {
  const source = readFileSync(join(root, document), "utf8");
  const examples = [...source.matchAll(/```ts\r?\n([\s\S]*?)\r?\n```/g)];
  assert.ok(examples.length > 0, `${document} requires a TypeScript example`);
  for (const [index, example] of examples.entries()) {
    test(`${document} caller example ${index + 1} compiles and executes`, () => {
      const project = isolatedProject();
      try {
        const file = join(project.directory, "consumer.ts");
        writeFileSync(file, example[1]!);
        const checked = compile(project.config);
        assert.equal(checked.status, 0, checked.output);
        const executed = spawnSync(process.execPath, [file], {
          cwd: project.directory,
          encoding: "utf8",
          timeout: 30_000,
        });
        if (executed.error) throw executed.error;
        assert.equal(executed.status, 0, `${executed.stdout}${executed.stderr}`);
      } finally {
        project.dispose();
      }
    });
  }
}
