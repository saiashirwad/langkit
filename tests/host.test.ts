import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { compile, fragment, isolatedProject, root } from "../tools/type-contracts.ts";

type Misuse = {
  readonly claim: string;
  readonly original: string;
  readonly replacement: string;
  readonly code: `TS${number}`;
};

type GuestError = {
  readonly file: string;
  readonly source: string;
  readonly at: string;
  readonly message: string;
};

type HostCase = {
  readonly language: string;
  readonly consumer: string;
  readonly output: string;
  readonly misuses: readonly Misuse[];
  readonly guestErrors: readonly GuestError[];
};

const cases: readonly HostCase[] = [
  {
    language: "toy",
    consumer: "examples/typescript/toy.ts",
    output: "42\n",
    misuses: [{
      claim: "the default export is a number",
      original: "const answer: number = main;",
      replacement: "const answer: string = main;",
      code: "TS2322",
    }],
    guestErrors: [{
      file: "examples/toy/main.toy",
      source: "let x = 1 in x + true\n",
      at: "true",
      message: "Expected number, found boolean",
    }],
  },
  {
    language: "advanced",
    consumer: "examples/typescript/advanced.ts",
    output: "The answer is:\n49\n49 10 20 2 20 true 7\n",
    misuses: [
      {
        claim: "data values cannot be forged structurally",
        original: "fromList(10)(numbers)",
        replacement: "(() => ({ tag: \"Tree.Leaf\", fields: [10] }))()",
        code: "TS2741",
      },
      {
        claim: "data type arguments are checked",
        original: "mapList((n: number) => `#${n}`)",
        replacement: "mapList((n: number) => n)",
        code: "TS2322",
      },
      {
        claim: "a data type from another guest module keeps its identity",
        original: "fromList(10)(numbers)",
        replacement: "fromList(10)(first)",
        code: "TS2741",
      },
      {
        claim: "a monomorphic function is not rank-2 polymorphic",
        original: "both(<A>(x: A) => x)",
        replacement: "both((x: number) => x)",
        code: "TS2345",
      },
      {
        claim: "an open row still requires its fields",
        original: "{ value: always(7)(\"ignored\"), unit: \"kg\" }",
        replacement: "{ unit: \"kg\" }",
        code: "TS2345",
      },
    ],
    guestErrors: [
      {
        file: "examples/advanced/main.advanced",
        source: "import \"./stdlib.advanced\";\nlength(1) + 2\n",
        at: "1",
        message: "Cannot unify number with List(a)",
      },
      {
        file: "examples/advanced/trees.advanced",
        source: "let flagged = fn(record) => { flag = true | record } in\n{ flagged = flagged }\n",
        at: "flagged = fn",
        message: "TypeScript cannot represent flagged: a record row that must lack flag",
      },
      {
        file: "examples/advanced/trees.advanced",
        source: "import \"./stdlib.advanced\";\nlet empty = Nil in\n{ empty = empty }\n",
        at: "empty = Nil",
        message: "TypeScript cannot represent empty: a polymorphic value that is not a function",
      },
    ],
  },
  {
    language: "hm",
    consumer: "examples/typescript/hm.ts",
    output: "42 true 5 hey!!\n",
    misuses: [
      {
        claim: "a plain HM result keeps its type",
        original: "const total: number = answer;",
        replacement: "const total: string = answer;",
        code: "TS2322",
      },
      {
        claim: "a generic is inferred, not collapsed to unknown",
        original: "twice((n: number) => n + 2)(1)",
        replacement: "twice((n: number) => n + 2)(\"one\")",
        code: "TS2345",
      },
      {
        claim: "types flow through a staged generic",
        original: "(s: string) => s.length)",
        replacement: "(s: boolean) => 1)",
        code: "TS2322",
      },
    ],
    guestErrors: [{
      file: "examples/hm/main.hm",
      source: "let x = 1 in x + true\n",
      at: "true",
      message: "Cannot unify boolean with number",
    }],
  },
  {
    language: "schema",
    consumer: "examples/typescript/schema.ts",
    output: "true 2 190\n2026-01-01 00:00:00 true\n"
      + "{\"email\":\"sai@example.com\",\"role\":\"Admin\"} {\"title\":\"Hello\",\"authorId\":1}\n",
    misuses: [
      {
        claim: "DateTime fields are strings",
        original: "const timestamp: string = author.updatedAt;",
        replacement: "const timestamp: number = author.updatedAt;",
        code: "TS2322",
      },
      {
        claim: "enums are closed unions",
        original: "const role: Role = \"Admin\";",
        replacement: "const role: Role = \"Owner\";",
        code: "TS2322",
      },
      {
        claim: "references require the referenced key's brand",
        original: "({ title: \"Hello\", authorId: by.id })",
        replacement: "({ title: \"Hello\", authorId: 1 })",
        code: "TS2322",
      },
      {
        claim: "primary keys of different models are distinct",
        original: "entry.authorId === by.id",
        replacement: "entry.id === by.id",
        code: "TS2367",
      },
      {
        claim: "insert types omit auto-increment keys",
        original: "{ email: author.email, role }",
        replacement: "{ id: author.id, email: author.email, role }",
        code: "TS2353",
      },
    ],
    guestErrors: [{
      file: "examples/schema/simple.schema",
      source: "model User = { id : Int |> primaryKey, role : Missing }\n",
      at: "Missing",
      message: "Unknown field type: Missing",
    }],
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
    project(host.consumer, {}, (directory) => {
      const clean = typecheck(directory);
      assert.equal(clean.status, 0, clean.output);
    });
  });

  for (const misuse of host.misuses) {
    test(`${host.language}: tsc rejects a consumer that breaks the claim that ${misuse.claim}`, () => {
      const consumer = readFileSync(join(root, host.consumer), "utf8");
      const seed = fragment(consumer, misuse.original);
      const misused = consumer.slice(0, seed.index) + misuse.replacement
        + consumer.slice(seed.index + seed.text.length);
      project(host.consumer, { [host.consumer]: misused }, (directory) => {
        const checked = typecheck(directory);
        assert.notEqual(checked.status, 0, "misuse must fail");
        assert.deepEqual(
          checked.errors.map(({ file, line, source }) => ({ file, line, source })),
          [{ file: join(directory, host.consumer), line: position(misused, seed.index).line, source: "TS" }],
          checked.output,
        );
        assert.ok(checked.output.includes(`error ${misuse.code}:`), checked.output);
      });
    });
  }

  test(`${host.language}: the loader runs the consumer`, () => {
    const result = run(root, host.consumer);
    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, host.output);
  });

  for (const { file, source, at, message } of host.guestErrors) {
    test(`${host.language}: the guest error "${message}" surfaces at the guest position`, () => {
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
}
