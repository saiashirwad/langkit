import { project } from "langkit/host";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { declarations } from "../examples/grammar/grammar-host.ts";
import { checkSource } from "../examples/grammar/grammar.ts";

const header = "grammar G\nskip = /\\s+/\nword = /[a-z]+/\n";

/** Each case lists the diagnostics as the message's start and the guest text at its span. */
type Case = {
  readonly name: string;
  readonly body: string;
  readonly errors: readonly (readonly [message: string, at: string])[];
};

const accepted = (name: string, body: string): Case => ({ name, body, errors: [] });

const cases: readonly Case[] = [
  {
    name: "direct left recursion",
    body: "A = A \"x\" | \"y\"",
    errors: [["Left recursion: A -> A", "A"]],
  },
  {
    name: "indirect left recursion names the whole cycle",
    body: "A = B \"x\" | \"y\"\nB = C\nC = A \"z\"",
    errors: [["Left recursion: A -> B -> C -> A", "B"]],
  },
  {
    name: "left recursion behind a nullable prefix",
    body: "A = \"q\"? A \"x\" | \"y\"",
    errors: [["Left recursion: A -> A", "A"]],
  },
  {
    name: "left recursion behind a nullable rule",
    body: "A = B A \"x\" | \"y\"\nB = \"p\"*",
    errors: [["Left recursion: A -> A", "A"]],
  },
  {
    name: "left recursion behind a lookahead",
    body: "A = &A \"x\" | \"y\"",
    errors: [["Left recursion: A -> A", "A"]],
  },
  {
    name: "left recursion through a nullable list item",
    body: "A = x:(A sepBy \",\" \",\")",
    errors: [["Left recursion: A -> A", "A"]],
  },
  {
    name: "mutual left recursion through three rules",
    body: "A = B | \"x\"\nB = C? D\nC = \"y\"\nD = A \"z\"",
    errors: [["Left recursion: A -> B -> D -> A", "B"]],
  },
  {
    name: "left recursion in a precedence atom",
    body: "E = precedence {\n left \"+\"\n atom #p E:E \"x\" | #n n:/[0-9]+/\n}",
    errors: [["Left recursion: E -> E", "E"]],
  },
  accepted("a rule that consumes before it recurses", "A = \"(\" A \")\" | \"y\""),
  accepted("a rule that recurses after an optional that must consume", "A = \"p\"? \"q\" A | \"c\""),
  {
    name: "a repetition of something nullable",
    body: "A = (\"x\"?)* \"y\"",
    errors: [["This repetition can match nothing", "(\"x\"?)*"]],
  },
  {
    name: "a repetition of a nullable rule",
    body: "A = B* \"y\"\nB = \"x\"?",
    errors: [["This repetition can match nothing", "B*"]],
  },
  {
    name: "a list whose item is nullable",
    body: "A = B sepBy \",\" \",\"\nB = \"x\"*",
    errors: [["This list item can match nothing", "B sepBy \",\""]],
  },
  {
    name: "a shorter symbol before the longer one it prefixes",
    body: "A = \"=\" | \"==\"",
    errors: [["Unreachable alternative", "\"==\""]],
  },
  accepted("the longer symbol first", "A = \"==\" | \"=\""),
  accepted("a keyword is not a prefix of a longer word", "A = \"in\" | \"int\""),
  accepted("a keyword before a longer keyword", "A = \"in\" | \"inx\""),
  {
    name: "a repeated alternative",
    body: "A = \"a\" \"b\" | \"a\" \"b\"",
    errors: [["Unreachable alternative: an earlier alternative is the same", "\"a\" \"b\""]],
  },
  {
    name: "an alternative that continues an earlier one",
    body: "A = \"a\" | \"a\" \"b\"",
    errors: [["Unreachable alternative", "\"a\" \"b\""]],
  },
  {
    name: "an alternative after one that always succeeds",
    body: "A = \"a\"? | \"b\"",
    errors: [["Unreachable alternative: an earlier alternative always succeeds", "\"b\""]],
  },
  {
    name: "a literal a token pattern already matches",
    body: "token N = /[0-9]+/\nA = N | \"12\"",
    errors: [["Unreachable alternative", "\"12\""]],
  },
  accepted("two patterns, which are not compared", "A = /[a-z]+/ | /abc/"),
  {
    name: "a cut commits before the later alternative starts the same way",
    body: "A = \"t\" ~ ident | \"t\" ident \"=\" ident",
    errors: [
      ["2 captures in one sequence", "\"t\" ident \"=\" ident"],
      ["Unreachable alternative: an earlier alternative commits", "\"t\" ident \"=\" ident"],
    ],
  },
  {
    name: "a cut commits, with tags and labels",
    body: "A = #a \"t\" ~ x:ident | #b \"t\" x:ident \"=\" y:ident",
    errors: [["Unreachable alternative: an earlier alternative commits", "#b \"t\" x:ident \"=\" y:ident"]],
  },
  accepted("a cut after a different start", "A = \"a\" ~ \"b\" | \"c\""),
  accepted("a longer symbol after the shorter one it is not a prefix of in sequence", "A = \"=\" \"x\" | \"==\" \"y\""),
  accepted("an optional start that the next alternative does not share", "A = \"p\"? \"b\" | \"p\" \"c\""),
  accepted("symbols that differ after the first character", "A = \"<\" \"x\" | \"<=\""),
  {
    name: "an infallible tail after a shared start",
    body: "A = \"a\" \"b\"? | \"a\" \"b\"",
    errors: [["Unreachable alternative", "\"a\" \"b\""]],
  },
  {
    name: "a rule reference that matches the later alternative's start",
    body: "A = B | \"x\" \"y\"\nB = \"x\"",
    errors: [["Unreachable alternative", "\"x\" \"y\""]],
  },
  {
    name: "a shorter symbol in the middle of a sequence",
    body: "A = \"a\" \"<\" | \"a\" \"<=\"",
    errors: [["Unreachable alternative", "\"a\" \"<=\""]],
  },
  {
    name: "a group that holds the later alternative",
    body: "A = (\"a\" | \"b\") | \"a\"",
    errors: [["Unreachable alternative", "\"a\""]],
  },
  {
    name: "a repetition that covers the later alternative",
    body: "A = \"a\"+ | \"a\" \"a\"",
    errors: [["Unreachable alternative", "\"a\" \"a\""]],
  },
  {
    name: "predicates are compared by equality",
    body: "A = !\"x\" \"y\" | !\"x\" \"y\" \"z\"",
    errors: [["Unreachable alternative", "!\"x\" \"y\" \"z\""]],
  },
  {
    name: "an unknown rule suggests a near name",
    body: "A = Bee\nBe = \"x\"",
    errors: [["Unknown rule: Bee; did you mean Be?", "Bee"]],
  },
  {
    name: "rules and tokens nothing reaches",
    body: "A = \"x\"\nB = \"y\"\nC = B\ntoken T = /z/",
    errors: [
      ["Unused rule: B is not reachable from A", "B"],
      ["Unused rule: C is not reachable from A", "C"],
      ["Unused token: T", "T"],
    ],
  },
  {
    name: "a capture in a node that nothing names",
    body: "A = x:B ident\nB = ident",
    errors: [["Label this capture, or discard it with _:", "ident"]],
  },
  {
    name: "alternatives that build nodes need tags",
    body: "A = x:ident | y:ident",
    errors: [
      ["Tag each alternative", "x:ident"],
      ["Tag each alternative", "y:ident"],
      ["Unreachable alternative: an earlier alternative is the same", "y:ident"],
    ],
  },
  {
    name: "patterns with anchors, lookaround, or an empty match",
    body: "A = /^x/ | /(?=y)y/ | /a*/",
    errors: [
      ["A pattern cannot use anchors", "/^x/"],
      ["A pattern cannot use lookaround", "/(?=y)y/"],
      ["A pattern cannot match the empty string", "/a*/"],
    ],
  },
  {
    name: "word boundaries and backreferences",
    body: "A = /\\bx/ | /(a)\\1/",
    errors: [
      ["A pattern cannot use a word boundary", "/\\bx/"],
      ["A pattern cannot use a backreference", "/(a)\\1/"],
    ],
  },
  {
    name: "a pattern that is not a regular expression",
    body: "A = /(x/",
    errors: [["Invalid pattern", "/(x/"]],
  },
  {
    name: "a duplicate declaration",
    body: "A = \"x\"\nA = \"y\"",
    errors: [["Duplicate declaration: A", "A"]],
  },
  {
    name: "a rule named for the built-in token",
    body: "A = ident\nident = \"y\"",
    errors: [["ident is built in", "ident"]],
  },
  {
    name: "an empty literal",
    body: "A = \"\" \"x\"",
    errors: [["A literal cannot be empty", "\"\""]],
  },
  {
    name: "labels the node reserves",
    body: "A = kind:ident span:ident",
    errors: [["kind is reserved", "kind"], ["span is reserved", "span"]],
  },
  {
    name: "a duplicate label",
    body: "A = x:ident x:ident",
    errors: [["Duplicate label: x", "x"]],
  },
  {
    name: "a label on something that captures nothing",
    body: "A = x:\"a\"? y:Z\nZ = \"z\"",
    errors: [["y captures nothing", "y"]],
  },
  {
    name: "a label inside a group",
    body: "A = #n x:(y:ident)",
    errors: [["A labeled group needs a rule of its own", "y"]],
  },
  {
    name: "a tag inside a group",
    body: "A = #n x:(#t ident)",
    errors: [["Tags go on the alternatives of a rule", "t"]],
  },
  {
    name: "a captured group that only sometimes captures",
    body: "A = #n x:(ident | \"a\" \"b\")",
    errors: [["Every alternative of a captured group must capture", "(ident | \"a\" \"b\")"]],
  },
  {
    name: "two values in one pass-through sequence",
    body: "A = ident ident",
    errors: [["2 captures in one sequence", "ident ident"]],
  },
  {
    name: "a duplicate tag",
    body: "A = #t \"a\" x:ident | #t \"b\" y:ident",
    errors: [["Duplicate tag: t", "t"]],
  },
  {
    name: "an empty grammar",
    body: "",
    errors: [["A grammar needs at least one rule", "G"]],
  },
  {
    name: "the same operator twice in a precedence block",
    body: "E = precedence {\n left \"+\"\n left \"+\" | \"-\"\n atom #n n:ident\n}",
    errors: [["Operator \"+\" is already declared", "\"+\""]],
  },
  {
    name: "an infix and a prefix operator may share text",
    body: "E = precedence {\n left \"-\"\n prefix \"-\"\n atom #n n:ident\n}",
    errors: [],
  },
  {
    name: "a precedence atom that is not a node",
    body: "E = precedence {\n left \"+\"\n atom ident\n}",
    errors: [["An atom of E must be a node", "ident"]],
  },
  {
    name: "a precedence atom needs a tag",
    body: "E = precedence {\n left \"+\"\n atom n:ident\n}",
    errors: [["Tag each alternative", "n:ident"]],
  },
  {
    name: "two rules whose interfaces would share a name",
    body: "A = #b \"b\" x:ident | #c \"c\" y:ident | AB\nAB = z:ident",
    errors: [["AB is already the TypeScript name of another declaration", "AB"]],
  },
  {
    name: "a rule named for a type the projection imports",
    body: "Result = x:ident",
    errors: [["TypeScript cannot represent Result", "Result"]],
  },
  {
    name: "skip declared twice",
    body: "skip = /x/\nA = ident",
    errors: [["skip is already declared", "skip = /x/"]],
  },
];

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
