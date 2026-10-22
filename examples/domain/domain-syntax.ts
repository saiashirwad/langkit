import type { Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import type { ImportParser } from "langkit/modules";
import {
  between,
  choice,
  commit,
  createLexemes,
  many,
  named,
  optional,
  parsePrefixResult,
  type Parser,
  parser,
  parseResult,
  regex,
  sepBy1,
  sepEndBy,
} from "langkit/parse";

export type Name = { readonly name: string; readonly span: Span; };

/** `String`, `[LineItem]`, `Address?`. A name resolves to a scalar or a declared type. */
export type TypeExpr =
  & { readonly span: Span; }
  & (
    | { readonly kind: "named"; readonly name: Name; }
    | { readonly kind: "list"; readonly element: TypeExpr; }
    | { readonly kind: "optional"; readonly inner: TypeExpr; }
  );

export type Field = { readonly name: Name; readonly type: TypeExpr; };

/** A field, or `...Placed` splicing a record's fields in place. */
export type Entry =
  | { readonly kind: "field"; readonly field: Field; }
  | { readonly kind: "spread"; readonly record: Name; };

/** `|> on pay -> Paid`; `span` covers the clause and is where a trace step through it points. */
export type On = { readonly event: Name; readonly target: Name; readonly span: Span; };

export type Role = "initial" | "final" | "step";

export type MachineItem =
  | { readonly kind: "event"; readonly name: Name; readonly payload: readonly Field[]; }
  | {
    readonly kind: "state";
    readonly name: Name;
    readonly role: Role;
    /** The `initial` or `final` keyword, so role diagnostics can point at it. */
    readonly marker: Span | undefined;
    readonly entries: readonly Entry[];
    readonly on: readonly On[];
  };

/** A union member; `fields` is undefined when it is written bare. */
export type Member = { readonly name: Name; readonly fields: readonly Field[] | undefined; };

/** `import { Address, LineItem } from "./commerce.domain"`; `span` covers the whole directive. */
export type Import = { readonly names: readonly Name[]; readonly path: string; readonly span: Span; };

/** One `.domain` file: any mix of types and machines. Every top-level name is exported. */
export type Declaration =
  /** `brand OrderId = String`; `underlying` must name a scalar, which the checker decides. */
  | { readonly kind: "brand"; readonly name: Name; readonly underlying: Name; }
  /** `Post | Courier`, or with payloads, `Card { last4 : String } | Transfer { reference : String }`. */
  | { readonly kind: "union"; readonly name: Name; readonly members: readonly Member[]; }
  | { readonly kind: "record"; readonly name: Name; readonly fields: readonly Field[]; }
  | { readonly kind: "machine"; readonly name: Name; readonly items: readonly MachineItem[]; };

const words = /[a-zA-Z_][a-zA-Z_0-9]*/;

export const keywords = [
  "import",
  "from",
  "type",
  "brand",
  "machine",
  "event",
  "state",
  "initial",
  "final",
  "on",
] as const;

const lex = createLexemes({
  trivia: regex(/(?:\s|\/\/[^\r\n]*)*/),
  identifier: words,
  keywords,
});

const { keyword, symbol } = lex;

const name = named(lex.identifier);
// `state` is a keyword, but a field named it is a representability error for the checker, not a parse error.
const fieldName = named(choice(lex.identifier, keyword("state")));

/** A token with the span of its text alone, not the trivia after it. */
const at = <T extends string>(token: Parser<T>): Parser<{ readonly text: T; readonly span: Span; }> =>
  token.withSpan((text, span) => ({ text, span: { start: span.start, end: span.start + text.length } }));

const dataType: Parser<TypeExpr> = parser(function*(): Generator<Parser<unknown>, TypeExpr, never> {
  let type: TypeExpr = yield* choice(
    name.map((name): TypeExpr => ({ kind: "named", name, span: name.span })),
    parser(function*(): Generator<Parser<unknown>, TypeExpr, never> {
      const open = yield* at(symbol("["));
      const element = yield* dataType;
      const close = yield* at(symbol("]"));
      return { kind: "list", element, span: { start: open.span.start, end: close.span.end } };
    }),
  );
  for (let mark = yield* optional(at(symbol("?"))); mark; mark = yield* optional(at(symbol("?")))) {
    type = { kind: "optional", inner: type, span: { start: type.span.start, end: mark.span.end } };
  }
  return type;
});

const field: Parser<Field> = parser(function*() {
  const id = yield* fieldName;
  yield* symbol(":");
  yield* commit();
  return { name: id, type: yield* dataType };
});

const fields = between(symbol("{"), symbol("}"), sepEndBy(field, symbol(",")));

const member: Parser<Member> = parser(function*() {
  const id = yield* name;
  return { name: id, fields: yield* optional(fields) };
});

const entry: Parser<Entry> = choice(
  symbol("...").zipRight(name).map((record): Entry => ({ kind: "spread", record })),
  field.map((field): Entry => ({ kind: "field", field })),
);

const clause: Parser<On> = parser(function*() {
  const pipe = yield* at(symbol("|>"));
  yield* commit();
  yield* keyword("on");
  const event = yield* name;
  yield* symbol("->");
  const target = yield* name;
  return { event, target, span: { start: pipe.span.start, end: target.span.end } };
});

const item: Parser<MachineItem> = choice(
  parser(function*() {
    yield* keyword("event");
    yield* commit();
    const id = yield* name;
    const payload = yield* optional(between(symbol("("), symbol(")"), sepEndBy(field, symbol(","))));
    return { kind: "event" as const, name: id, payload: payload ?? [] };
  }),
  parser(function*() {
    const marker = yield* optional(choice(at(keyword("initial")), at(keyword("final"))));
    yield* keyword("state");
    yield* commit();
    const id = yield* name;
    const entries = yield* optional(
      symbol("=").zipRight(between(symbol("{"), symbol("}"), sepEndBy(entry, symbol(",")))),
    );
    return {
      kind: "state" as const,
      name: id,
      role: marker?.text ?? ("step" as const),
      marker: marker?.span,
      entries: entries ?? [],
      on: yield* many(clause),
    };
  }),
);

const declaration: Parser<Declaration> = choice(
  parser(function*() {
    yield* keyword("brand");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    return { kind: "brand" as const, name: id, underlying: yield* name };
  }),
  parser(function*() {
    yield* keyword("type");
    yield* commit();
    const id = yield* name;
    yield* symbol("=");
    return yield* choice(
      fields.map((fields) => ({ kind: "record" as const, name: id, fields })),
      sepBy1(member, symbol("|")).map((members) => ({ kind: "union" as const, name: id, members })),
    );
  }),
  parser(function*() {
    yield* keyword("machine");
    yield* commit();
    const id = yield* name;
    const items = yield* between(symbol("{"), symbol("}"), many(item));
    return { kind: "machine" as const, name: id, items };
  }),
);

const directive: Parser<Import> = parser(function*() {
  const start = yield* at(keyword("import"));
  yield* commit();
  const names = yield* between(symbol("{"), symbol("}"), sepEndBy(name, symbol(",")));
  yield* keyword("from");
  const path = yield* at(lex.token(regex(/"[^"\\\r\n]*"/)));
  return { names, path: path.text.slice(1, -1), span: { start: start.span.start, end: path.span.end } };
});

const directives = lex.trivia.zipRight(many(directive));

/** Imports come first, so `imports` reads them without parsing the rest of the file. */
export type File = { readonly imports: readonly Import[]; readonly declarations: readonly Declaration[]; };

export const program: Parser<File> = lex.complete(parser(function*() {
  const imports = yield* many(directive);
  return { imports, declarations: yield* many(declaration) };
}));

export const parse = (source: string): Result<File> => parseResult(program, source);

/** The prefix parser `loadModules` calls; the names inside are elaboration's business. */
export const imports: ImportParser = (source) => {
  const parsed = parsePrefixResult(directives, source);
  return parsed.success
    ? { success: true, value: parsed.value.map(({ path, span }) => ({ path, span })) }
    : parsed;
};

export const tokens: readonly TokenRule[] = [
  { pattern: /\/\/[^\r\n]*/, kind: () => undefined },
  { pattern: /"[^"\r\n]*"/, kind: "string" },
  {
    pattern: words,
    kind: (text) => ((keywords as readonly string[]).includes(text) ? "keyword" : "variable"),
  },
  { pattern: /\|>|->|\.\.\.|[\[\]?:=|]/, kind: "operator" },
];
