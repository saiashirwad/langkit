import { get, run, scoped, within, type Check, type Result } from "./check.ts";
import type { Diagnostic, SourceLocation, Span } from "./diagnostic.ts";

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

export type Token = { readonly span: Span; readonly kind: TokenKind };

export type Typed<T> = { readonly span: Span; readonly type: T };

export type Definition<T = unknown> = {
  readonly id: symbol;
  readonly name: string;
  readonly span: Span;
  readonly kind: DefinitionKind;
  readonly type?: T;
  /** Present only for definitions outside the analyzed document. */
  readonly uri?: string;
  readonly location?: SourceLocation;
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

export type Reference = { readonly id: symbol; readonly span: Span };

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

type Binding<T> = {
  readonly id: symbol;
  readonly name: string;
  readonly type?: T;
  readonly uri?: string;
  readonly location?: SourceLocation;
};

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
      kind: DefinitionKind = "variable",
    ): Check<void> =>
      get(current).map((facts) => {
        facts?.definitions.push({ ...binding, span, kind });
        if (binding.type !== undefined) facts?.types.push({ type: binding.type, span });
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
    : analysis.definitions.find((value) => !value.uri && !value.location && contains(value.span, offset));
};

/** Refine lexical tokens without introducing overlapping or duplicate ranges. */
export const semanticTokens = <T>(analysis: Analysis<T>): readonly Token[] => {
  const definitions = new Map(analysis.definitions.map((value) => [value.id, value]));
  const roles = new Map<string, TokenKind>();
  const key = (span: Span) => `${span.start}:${span.end}`;
  for (const definition of analysis.definitions)
    if (!definition.uri && !definition.location) roles.set(key(definition.span), definition.kind);
  for (const reference of analysis.references) {
    const definition = definitions.get(reference.id);
    if (definition) roles.set(key(reference.span), definition.kind);
  }
  return analysis.tokens.map((token) => ({
    ...token,
    kind: roles.get(key(token.span)) ?? token.kind,
  }));
};
