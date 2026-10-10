import { get, run, scoped, within, type Check, type Result } from "./check.ts";
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
] as const;

export type TokenKind = (typeof tokenKinds)[number];

export type Token = { readonly span: Span; readonly kind: TokenKind };

export type Typed<T> = { readonly span: Span; readonly type: T };

export type Definition<T> = Typed<T> & {
  readonly id: symbol;
  readonly name: string;
  readonly kind: "variable" | "parameter" | "function";
  /** Present only for definitions outside the analyzed document. */
  readonly uri?: string;
};

export type Reference = { readonly id: symbol; readonly span: Span };

/** Source facts, independent of any IR or editor protocol. Offsets are UTF-16. */
export type Analysis<T> = {
  readonly diagnostics: readonly Diagnostic[];
  readonly types: readonly Typed<T>[];
  readonly definitions: readonly Definition<T>[];
  readonly references: readonly Reference[];
  readonly tokens: readonly Token[];
  /** Imported source snapshots for cross-file definition ranges. */
  readonly sources?: ReadonlyMap<string, string>;
};

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
  for (let offset = 0; offset < source.length; ) {
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
  types: Typed<T>[];
  definitions: Definition<T>[];
  references: Reference[];
};

type Binding<T> = { readonly id: symbol; readonly name: string; readonly type: T };

/** Optional observation: without collect, these operations do not retain facts. */
export const create = <T>() => {
  const current = scoped<Facts<T> | undefined>(undefined);

  return {
    typed: (type: T, span: Span): Check<void> =>
      get(current).map((facts) => {
        facts?.types.push({ type, span });
      }),

    define: (
      binding: Binding<T>,
      span: Span,
      kind: Definition<T>["kind"] = "variable",
    ): Check<void> =>
      get(current).map((facts) => {
        facts?.definitions.push({ ...binding, span, kind });
        facts?.types.push({ type: binding.type, span });
      }),

    // Identity comes from the declaration; the use-site type is reported by typed.
    reference: (binding: { readonly id: symbol }, span: Span): Check<void> =>
      get(current).map((facts) => {
        facts?.references.push({ id: binding.id, span });
      }),

    collect: <A>(
      body: Check<A>,
      tokens: readonly Token[] = [],
    ): { result: Result<A>; analysis: Analysis<T> } => {
      const facts: Facts<T> = { types: [], definitions: [], references: [] };
      const result = run(within(current, facts, body));
      return {
        result,
        analysis: {
          ...facts,
          diagnostics: result.success ? [] : [result.error],
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
      contains(value.span, offset) &&
      (!found || value.span.end - value.span.start < found.span.end - found.span.start)
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
  for (const definition of analysis.definitions)
    if (!definition.uri) roles.set(key(definition.span), definition.kind);
  for (const reference of analysis.references) {
    const definition = definitions.get(reference.id);
    if (definition) roles.set(key(reference.span), definition.kind);
  }
  return analysis.tokens.map((token) => ({
    ...token,
    kind: roles.get(key(token.span)) ?? token.kind,
  }));
};
