import { Check, type Result, run, scoped, type State, state, within } from "./check.ts";
import type { Diagnostic, Span } from "./diagnostic.ts";

export const tokenKinds = [
  "keyword",
  "number",
  "type",
  "variable",
  "parameter",
  "function",
  "operator",
  "string",
  "model",
  "enum",
  "enumMember",
  "macro",
  "field",
  "class",
  "interface",
  "namespace",
  "property",
  "method",
  "constructor",
  "constant",
] as const;

export type TokenKind = (typeof tokenKinds)[number];

export type Token = { readonly span: Span; readonly kind: TokenKind; };

export type Typed<T> = { readonly span: Span; readonly type: T; };

export type Definition<T = unknown> = {
  readonly id: symbol;
  readonly name: string;
  readonly span: Span;
  readonly kind: DefinitionKind;
  readonly type?: T;
  /** Present only for definitions outside the analyzed document. */
  readonly uri?: string;
};

export type DefinitionKind =
  | "variable"
  | "parameter"
  | "function"
  | "type"
  | "model"
  | "enum"
  | "enumMember"
  | "macro"
  | "field"
  | "class"
  | "interface"
  | "namespace"
  | "property"
  | "method"
  | "constructor"
  | "constant";

export type Reference = { readonly id: symbol; readonly span: Span; };

/** Source facts, independent of any IR or editor protocol. Offsets are UTF-16. */
export type Analysis<T> = {
  readonly diagnostics: readonly Diagnostic[];
  readonly types: readonly Typed<T>[];
  readonly definitions: readonly Definition<T>[];
  readonly references: readonly Reference[];
  readonly tokens: readonly Token[];
  /** Imported source snapshots for cross-file definitions and diagnostics. */
  readonly sources?: ReadonlyMap<string, string>;
  /** URIs read while producing this analysis, including transitive inputs. */
  readonly dependencyUris?: readonly string[];
};

export const unanalyzed = <T>(diagnostics: readonly Diagnostic[], tokens: readonly Token[] = []): Analysis<T> => ({
  diagnostics,
  types: [],
  definitions: [],
  references: [],
  tokens,
});

/** Ordered lexical rules. Unrecognized characters are skipped, so incomplete input still highlights. */
export type TokenRule = {
  readonly pattern: RegExp;
  readonly kind: TokenKind | ((text: string) => TokenKind | undefined);
};

export const highlight = (source: string, rules: readonly TokenRule[]): readonly Token[] => {
  const scanners = rules.map((rule) => ({
    ...rule,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, "") + "y"),
  }));
  const tokens: Token[] = [];
  for (let offset = 0; offset < source.length;) {
    let consumed = false;
    for (const rule of scanners) {
      rule.pattern.lastIndex = offset;
      const match = rule.pattern.exec(source);
      if (!match) continue;
      if (!match[0].length) throw new Error("Highlight rules must consume input");
      const end = offset + match[0].length;
      const kind = typeof rule.kind === "function" ? rule.kind(match[0]) : rule.kind;
      if (kind) tokens.push({ kind, span: { start: offset, end } });
      offset = end;
      consumed = true;
      break;
    }
    if (!consumed) offset += source.codePointAt(offset)! > 0xffff ? 2 : 1;
  }
  return tokens;
};

type Facts<T> = {
  types: (Typed<T> & { readonly document: string | undefined; })[];
  definitions: Definition<T>[];
  references: Reference[];
};

type Binding<T> = {
  readonly id: symbol;
  readonly name: string;
  readonly type?: T;
  readonly uri?: string;
};

/** Optional observation: without collect, these operations do not retain facts. */
export const create = <T>() => {
  const collecting = scoped<State<Facts<T>> | undefined>(undefined);
  const checkpoint = (value: Facts<T>) => {
    const lengths = [value.types.length, value.definitions.length, value.references.length] as const;
    return () => {
      value.types.length = lengths[0];
      value.definitions.length = lengths[1];
      value.references.length = lengths[2];
    };
  };
  const record = (write: (facts: Facts<T>, document: string | undefined) => void): Check<void> =>
    new Check((runtime) => {
      const selected = runtime.get(collecting);
      if (selected) write(runtime.get(selected), runtime.frame.document);
      return { ok: true, value: undefined };
    });

  return {
    typed: (type: T, span: Span): Check<void> =>
      record((facts, document) => facts.types.push({ type, span, document })),

    define: (
      binding: Binding<T>,
      span: Span,
      kind: DefinitionKind = "variable",
    ): Check<void> =>
      record((facts, document) => {
        facts.definitions.push({ ...binding, span, kind });
        if (binding.type !== undefined) facts.types.push({ type: binding.type, span, document });
      }),

    ignore: <A>(body: Check<A>): Check<A> => within(collecting, () => undefined, body),

    // Identity comes from the declaration; the use-site type is reported by typed.
    reference: (binding: { readonly id: symbol; }, span: Span): Check<void> =>
      record((facts) => facts.references.push({ id: binding.id, span })),

    collect: <A>(
      body: Check<A>,
      tokens: readonly Token[] = [],
    ): { result: Result<A>; analysis: Analysis<T>; } => {
      const facts: Facts<T> = { types: [], definitions: [], references: [] };
      const selected = state(() => facts, checkpoint);
      const result = run(within(collecting, () => selected, body));
      const types = facts.types.filter((value) =>
        result.success || !result.errors.some((diagnostic) => {
          const location = diagnostic.location ?? diagnostic.origin;
          const errorSpan = location?.span ?? diagnostic.span;
          if (!errorSpan || value.span.start > errorSpan.start || value.span.end < errorSpan.end) return false;
          if (value.span.start === errorSpan.start && value.span.end === errorSpan.end) return false;
          return value.document === location?.uri;
        })
      ).map(({ type, span }) => ({ type, span }));
      return {
        result,
        analysis: {
          types,
          definitions: facts.definitions,
          references: facts.references,
          diagnostics: result.success ? [] : [...result.errors],
          tokens,
        },
      };
    },
  };
};

const contains = (span: Span, offset: number): boolean => span.start <= offset && offset < span.end;

export const typeAt = <T>(analysis: Analysis<T>, offset: number): Typed<T> | undefined => {
  let found: Typed<T> | undefined;
  for (const value of analysis.types) {
    if (
      contains(value.span, offset)
      && (!found || value.span.end - value.span.start < found.span.end - found.span.start)
    ) {
      found = value;
    }
  }
  return found;
};

export const definitionAt = <T>(
  analysis: Analysis<T>,
  offset: number,
): Definition<T> | undefined => {
  const reference = analysis.references.find((value) => contains(value.span, offset));
  return reference
    ? analysis.definitions.find((value) => value.id === reference.id)
    : analysis.definitions.find((value) => !value.uri && contains(value.span, offset));
};

/** Refine lexical tokens without introducing overlapping or duplicate ranges. */
export const semanticTokens = <T>(analysis: Analysis<T>): readonly Token[] => {
  const definitions = new Map(analysis.definitions.map((value) => [value.id, value]));
  const roles = new Map<string, TokenKind>();
  const key = (span: Span) => `${span.start}:${span.end}`;
  for (const definition of analysis.definitions) {
    if (!definition.uri) roles.set(key(definition.span), definition.kind);
  }
  for (const reference of analysis.references) {
    const definition = definitions.get(reference.id);
    if (definition) roles.set(key(reference.span), definition.kind);
  }
  return analysis.tokens.map((token) => ({
    ...token,
    kind: roles.get(key(token.span)) ?? token.kind,
  }));
};
