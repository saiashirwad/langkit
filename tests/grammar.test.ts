import { project } from "langkit/host";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { declarations } from "../examples/grammar/grammar-host.ts";
import { checkSource } from "../examples/grammar/grammar.ts";
import { cases, header } from "./grammar-cases.ts";

for (const { name, body, errors } of cases) {
  test(`grammar diagnostics: ${name}`, () => {
    const source = `${header}${body}\n`;
    const checked = checkSource(source);
    const found = checked.success
      ? []
      : checked.errors.map((error) => [error.message, source.slice(error.span!.start, error.span!.end)]);
    assert.equal(found.length, errors.length, JSON.stringify(found));
    errors.forEach(([message, at], index) => {
      assert.ok(found[index]![0]!.startsWith(message), `${found[index]![0]} does not start with ${message}`);
      assert.equal(found[index]![1], at);
    });
  });
}

const projected = (source: string): string => {
  const checked = checkSource(source);
  assert.ok(checked.success, checked.success ? "" : checked.errors[0].message);
  return project(declarations(checked.value)).text;
};

test("the expression grammar projects its precedence nodes over itself", () => {
  const source = readFileSync(new URL("../examples/grammar/expr.grammar", import.meta.url), "utf8");
  assert.equal(
    projected(source),
    `import type { Result, Span } from "langkit";

export interface ExprBinary {
  readonly kind: "binary";
  readonly operator: "or" | "and" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/";
  readonly left: Expr;
  readonly right: Expr;
  readonly span: Span;
}
export interface ExprPrefix {
  readonly kind: "prefix";
  readonly operator: "not" | "-";
  readonly operand: Expr;
  readonly span: Span;
}
export interface ExprPostfix {
  readonly kind: "postfix";
  readonly operator: "!";
  readonly operand: Expr;
  readonly span: Span;
}
export type Expr = ExprBinary | ExprPrefix | ExprPostfix | Num | Path;

export interface Num {
  readonly kind: "Num";
  readonly value: string;
  readonly span: Span;
}

export interface Path {
  readonly kind: "Path";
  readonly head: string;
  readonly tail: readonly string[];
  readonly span: Span;
}

export declare function parse(source: string): Result<Expr>;
`,
  );
});

test("lists, optionals and literal unions project as the shapes a consumer can rely on", () => {
  assert.equal(
    projected(`${header}File = lines:Line+ "!" extra:(Name sepBy1 ",")? mode:("fast" | "slow")? groups:(Name+)*
Line = #pair left:ident "=" right:ident | #plain text:ident
Name = value:ident
`),
    `import type { Result, Span } from "langkit";

export interface File {
  readonly kind: "File";
  readonly lines: readonly [Line, ...Line[]];
  readonly extra: readonly Name[];
  readonly mode: "fast" | "slow" | null;
  readonly groups: readonly (readonly [Name, ...Name[]])[];
  readonly span: Span;
}

export interface LinePair {
  readonly kind: "pair";
  readonly left: string;
  readonly right: string;
  readonly span: Span;
}
export interface LinePlain {
  readonly kind: "plain";
  readonly text: string;
  readonly span: Span;
}
export type Line = LinePair | LinePlain;

export interface Name {
  readonly kind: "Name";
  readonly value: string;
  readonly span: Span;
}

export declare function parse(source: string): Result<File>;
`,
  );
});

test("a rule that only passes values through is an alias of their types", () => {
  const types = projected(`${header}Top = Value | Program
Program = Decl*
Decl = name:ident
Value = Decl | "(" Value ")"
`).split("\n").filter((line) => line.startsWith("export type"));
  assert.deepEqual(types, [
    "export type Top = Decl | readonly Decl[];",
    "export type Program = readonly Decl[];",
    "export type Value = Decl;",
  ]);
});

const cli = (path: string) =>
  spawnSync(process.execPath, ["examples/grammar/grammar.ts", path], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
  });

test("the CLI summarizes a good grammar and exits 0", () => {
  const result = cli("examples/grammar/domain.grammar");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Domain: 20 rules, 20 keywords\n/);
  assert.match(result.stdout, /Formula +is \| group \| binary\n/);
});

test("the CLI prints each diagnostic with its line and exits nonzero", () => {
  const directory = mkdtempSync(join(tmpdir(), "grammar-"));
  try {
    const path = join(directory, "bad.grammar");
    writeFileSync(path, "grammar G\nA = A \"x\"\n");
    const result = cli(path);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(`${path}: line 2, column 5: Left recursion: A -> A.`), result.stderr);
    assert.ok(result.stderr.includes("A = A \"x\"\n    ^"), result.stderr);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
