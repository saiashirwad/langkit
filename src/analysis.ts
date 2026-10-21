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

export type DefinitionKind = Exclude<TokenKind, "keyword" | "number" | "operator" | "string">;

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

const compiled = new WeakMap<readonly TokenRule[], readonly TokenRule[]>();
const scannersFor = (rules: readonly TokenRule[]): readonly TokenRule[] => {
  let scanners = compiled.get(rules);
  if (!scanners) {
    scanners = rules.map((rule) => ({
      ...rule,
      pattern: new RegExp(rule.pattern.source, rule.pattern.flags.replace(/[gy]/g, "") + "y"),
    }));
    compiled.set(rules, scanners);
  }
  return scanners;
};

export const highlight = (source: string, rules: readonly TokenRule[]): readonly Token[] => {
  const scanners = scannersFor(rules);
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

type Located<T> = Typed<T> & { readonly document: string | undefined; };
type Facts<T> = {
  types: Located<T>[];
  definitions: Definition<T>[];
  references: Reference[];
};

type Declared<T> = {
  readonly id: symbol;
  readonly name: string;
  readonly type?: T;
  readonly uri?: string;
};

/** A type recorded strictly around a failing span is unreliable, so it is dropped. */
const enclosesError = <T>(value: Located<T>, error: Diagnostic): boolean => {
  const location = error.location ?? error.origin;
  const span = location?.span ?? error.span;
  if (!span || location?.uri !== value.document) return false;
  const inside = value.span.start <= span.start && span.end <= value.span.end;
  const same = value.span.start === span.start && value.span.end === span.end;
  return inside && !same;
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

    define: (binding: Declared<T>, span: Span, kind: DefinitionKind = "variable"): Check<void> =>
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
      const errors = result.success ? [] : result.errors;
      const types = facts.types
        .filter((value) => !errors.some((error) => enclosesError(value, error)))
        .map(({ type, span }) => ({ type, span }));
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

export const referenceAt = <T>(analysis: Analysis<T>, offset: number): Reference | undefined =>
  analysis.references.find((value) => contains(value.span, offset));

export const definitionAt = <T>(analysis: Analysis<T>, offset: number): Definition<T> | undefined => {
  const reference = referenceAt(analysis, offset);
  return reference
    ? analysis.definitions.find((value) => value.id === reference.id)
    : analysis.definitions.find((value) => !value.uri && contains(value.span, offset));
};

/** Refine lexical tokens without introducing overlapping or duplicate ranges. */
export const semanticTokens = <T>(analysis: Analysis<T>): readonly Token[] => {
  const definitions = new Map(analysis.definitions.map((value) => [value.id, value]));
  const roles = new Map<number, Map<number, TokenKind>>();
  const assign = (span: Span, kind: TokenKind) => {
    const ends = roles.get(span.start) ?? new Map<number, TokenKind>();
    ends.set(span.end, kind);
    roles.set(span.start, ends);
  };
  for (const definition of analysis.definitions) {
    if (!definition.uri) assign(definition.span, definition.kind);
  }
  for (const reference of analysis.references) {
    const definition = definitions.get(reference.id);
    if (definition) assign(reference.span, definition.kind);
  }
  return analysis.tokens.map((token) => ({
    ...token,
    kind: roles.get(token.span.start)?.get(token.span.end) ?? token.kind,
  }));
};
