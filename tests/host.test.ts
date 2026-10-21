import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compile, fragment, isolatedProject, root } from "../tools/type-contracts.ts";

type Misuse = { readonly original: string; readonly replacement: string; readonly code: `TS${number}`; };

type HostCase = {
  readonly language: string;
  readonly consumer: string;
  readonly output: string;
  readonly misuse: Misuse;
  readonly controls?: readonly Misuse[];
  readonly guestError: {
    readonly file: string;
    readonly source: string;
    readonly at: string;
    readonly message: string;
  };
};

const cases: readonly HostCase[] = [
  {
    language: "toy",
    consumer: "examples/typescript/toy.ts",
    output: "42\n",
    misuse: {
      original: "const answer: number = main;",
      replacement: "const answer: string = main;",
      code: "TS2322",
    },
    guestError: {
      file: "examples/toy/main.toy",
      source: "let x = 1 in x + true\n",
      at: "true",
      message: "Expected number, found boolean",
    },
  },
  {
    language: "schema",
    consumer: "examples/typescript/schema.ts",
    output: "true 2 190\n2026-01-01 00:00:00 true\n"
      + "{\"email\":\"sai@example.com\",\"role\":\"Admin\"} {\"title\":\"Hello\",\"authorId\":1}\n",
    misuse: {
      original: "const timestamp: string = author.updatedAt;",
      replacement: "const timestamp: number = author.updatedAt;",
      code: "TS2322",
    },
    controls: [
      { original: "const role: Role = \"Admin\";", replacement: "const role: Role = \"Owner\";", code: "TS2322" },
      {
        original: "({ title: \"Hello\", authorId: by.id })",
        replacement: "({ title: \"Hello\", authorId: 1 })",
        code: "TS2322",
      },
      { original: "entry.authorId === by.id", replacement: "entry.id === by.id", code: "TS2367" },
      {
        original: "{ email: author.email, role }",
        replacement: "{ id: author.id, email: author.email, role }",
        code: "TS2353",
      },
    ],
    guestError: {
      file: "examples/schema/simple.schema",
      source: "model User = { id : Int |> primaryKey, role : Missing }\n",
      at: "Missing",
      message: "Unknown field type: Missing",
    },
  },
];

const project = <A>(consumer: string, edits: Readonly<Record<string, string>>, use: (directory: string) => A): A => {
  const isolated = isolatedProject([consumer]);
  try {
    cpSync(join(root, "examples"), join(isolated.directory, "examples"), { recursive: true });
    for (const [file, source] of Object.entries(edits)) writeFileSync(join(isolated.directory, file), source);
    return use(isolated.directory);
  } finally {
    isolated.dispose();
  }
};

const typecheck = (directory: string) => {
  const result = compile(join(directory, "tsconfig.json"));
  const errors = [...result.output.matchAll(/^(.+)\((\d+),(\d+)\): error (\w+?)\d+: (.*)$/gm)].map((match) => ({
    file: resolve(root, match[1]!),
    line: Number(match[2]),
    column: Number(match[3]),
    source: match[4],
    message: match[5],
  }));
  return { status: result.status, output: result.output, errors };
};

const run = (cwd: string, consumer: string) =>
  spawnSync(process.execPath, ["--import", "./examples/register.ts", consumer], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });

const position = (source: string, index: number) => {
  const before = source.slice(0, index).split("\n");
  return { line: before.length, column: before.at(-1)!.length + 1 };
};

for (const host of cases) {
  test(`${host.language}: tsc types the consumer through the content mapper`, () => {
    const consumer = readFileSync(join(root, host.consumer), "utf8");
    project(host.consumer, {}, (directory) => {
      const clean = typecheck(directory);
      assert.equal(clean.status, 0, clean.output);
    });
    for (const misuse of [host.misuse, ...host.controls ?? []]) {
      const seed = fragment(consumer, misuse.original);
      const misused = consumer.slice(0, seed.index) + misuse.replacement
        + consumer.slice(seed.index + seed.text.length);
      project(host.consumer, { [host.consumer]: misused }, (directory) => {
        const checked = typecheck(directory);
        assert.notEqual(checked.status, 0, `${misuse.replacement} must fail`);
        assert.deepEqual(
          checked.errors.map(({ file, line, source }) => ({ file, line, source })),
          [{ file: join(directory, host.consumer), line: position(misused, seed.index).line, source: "TS" }],
          checked.output,
        );
        assert.ok(checked.output.includes(`error ${misuse.code}:`), checked.output);
      });
    }
  });

  test(`${host.language}: the loader runs the consumer`, () => {
    const result = run(root, host.consumer);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, host.output);
  });

  test(`${host.language}: guest errors surface at the guest position`, () => {
    const { file, source, at, message } = host.guestError;
    const expected = position(source, fragment(source, at).index);
    project(host.consumer, { [file]: source }, (directory) => {
      const checked = typecheck(directory);
      assert.notEqual(checked.status, 0, "guest error must fail tsc");
      assert.deepEqual(
        checked.errors,
        [{ file: join(directory, file), ...expected, source: "langkit", message }],
        checked.output,
      );
      const executed = run(directory, host.consumer);
      assert.notEqual(executed.status, 0, "guest error must fail the loader");
      assert.match(executed.stderr, /SyntaxError/);
      assert.ok(
        executed.stderr.includes(
          `${join(directory, file)}: line ${expected.line}, column ${expected.column}: ${message}`,
        ),
        executed.stderr,
      );
    });
  });
}
