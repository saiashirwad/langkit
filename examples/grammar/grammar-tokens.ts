import type { TokenRule } from "langkit/analysis";
import { type Checked, symbolsOf } from "./grammar-model.ts";

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const digits = /^(?:\[0-9\]|\\d)[+*]$/;

/**
 * Highlighting derived from a checked grammar, so a language built on `.grammar` never keeps a second keyword
 * list in sync. First match wins: skipped text, named tokens, words, then symbols longest first.
 */
export const tokenRules = (grammar: Checked): readonly TokenRule[] => {
  const symbols = [...symbolsOf(grammar)].toSorted((a, b) => b.length - a.length);
  return [
    ...grammar.skip.map((source): TokenRule => ({ pattern: new RegExp(source), kind: () => undefined })),
    ...grammar.tokens.map(({ source }): TokenRule => ({
      pattern: new RegExp(source),
      kind: digits.test(source) ? "number" : "string",
    })),
    {
      pattern: new RegExp(grammar.word),
      kind: (text) => grammar.keywords.includes(text) ? "keyword" : "variable",
    },
    ...(symbols.length ? [{ pattern: new RegExp(symbols.map(escape).join("|")), kind: "operator" as const }] : []),
  ];
};
