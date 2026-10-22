import type { Result, Span } from "langkit";
import type { TokenRule } from "langkit/analysis";
import {
  between,
  choice,
  commit,
  createLexemes,
  many,
  named,
  optional,
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

/** One `.domain` file: any mix of types and machines. Every top-level name is exported. */
export type Declaration =
  /** `brand OrderId = String`; `underlying` must name a scalar, which the checker decides. */
  | { readonly kind: "brand"; readonly name: Name; readonly underlying: Name; }
  | { readonly kind: "enum"; readonly name: Name; readonly members: readonly Name[]; }
  | { readonly kind: "record"; readonly name: Name; readonly fields: readonly Field[]; }
  | { readonly kind: "machine"; readonly name: Name; readonly items: readonly MachineItem[]; };

const words = /[a-zA-Z_][a-zA-Z_0-9]*/;

export const keywords = ["type", "brand", "machine", "event", "state", "initial", "final", "on"] as const;

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
      sepBy1(name, symbol("|")).map((members) => ({ kind: "enum" as const, name: id, members })),
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

export const program = lex.complete(many(declaration));

export const parse = (source: string): Result<readonly Declaration[]> => parseResult(program, source);

export const tokens: readonly TokenRule[] = [
  { pattern: /\/\/[^\r\n]*/, kind: () => undefined },
  {
    pattern: words,
    kind: (text) => ((keywords as readonly string[]).includes(text) ? "keyword" : "variable"),
  },
  { pattern: /\|>|->|\.\.\.|[\[\]?:=|]/, kind: "operator" },
];
