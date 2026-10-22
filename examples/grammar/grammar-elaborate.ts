import type { Diagnostic, Span } from "langkit";
import { levenshteinDistance } from "parserator/diagnostics";
import {
  type Checked,
  type Expr,
  type Item,
  type Level,
  type Located,
  type Operator,
  type Rule,
  type RuleId,
  ruleId,
  type Seq,
  type Token,
  walk,
} from "./grammar-model.ts";
import type * as S from "./grammar-syntax.ts";

const defaultWord = "[A-Za-z_][A-Za-z0-9_]*";

const unsupported = [
  [/\(\?<?[=!]/, "lookaround"],
  [/(?<!\\)(?:\\\\)*\\[bB]/, "a word boundary"],
  [/(?<!\\)(?:\\\\)*\\(?:[1-9]|k<)/, "a backreference"],
] as const;

/**
 * A pattern is a plain regular expression. Anchors, lookaround, boundaries and backreferences are refused, which
 * is what makes "can it match nothing" and "does it cover this literal" decidable by running it.
 */
export const patternProblem = (source: string): string | undefined => {
  try {
    new RegExp(source);
  } catch (error) {
    return `Invalid pattern: ${(error as Error).message}`;
  }
  const outsideClasses = source.replace(/\\.|\[(?:[^\]\\]|\\.)*\]/g, "_");
  if (/[\^$]/.test(outsideClasses)) return "A pattern cannot use anchors";
  for (const [test, what] of unsupported) if (test.test(source)) return `A pattern cannot use ${what}`;
  if (new RegExp(`^(?:${source})`).exec("")) return "A pattern cannot match the empty string";
  return undefined;
};

export const error = (message: string, span: Span, related?: Diagnostic["related"]): Diagnostic =>
  related ? { message, context: [], span, related } : { message, context: [], span };

export type Elaborated = { readonly grammar: Checked; readonly errors: readonly Diagnostic[]; };

/**
 * Resolves names, validates patterns and derives the lexical model. Types and nodes come next, in `derive`. A
 * name that cannot be resolved lowers to a cut so the rest of the grammar is still checked.
 */
export const lower = (file: S.File): Elaborated => {
  const errors: Diagnostic[] = [];
  const report = (message: string, span: Span) => void errors.push(error(message, span));

  let skip: readonly string[] = [];
  let skipped = false;
  let word = defaultWord;
  let worded = false;
  const tokens: Token<Located>[] = [];
  const tokenIds = new Map<string, number>();
  const ruleIds = new Map<string, RuleId>();
  const declared: Extract<S.Item, { readonly kind: "rule"; }>[] = [];
  const taken = new Set<string>(["ident"]);

  const claim = (name: S.Name): boolean => {
    if (taken.has(name.name)) {
      report(name.name === "ident" ? "ident is built in" : `Duplicate declaration: ${name.name}`, name.span);
      return false;
    }
    taken.add(name.name);
    return true;
  };
  const checked = (pattern: S.Pattern): string => {
    const problem = patternProblem(pattern.source);
    if (problem) report(problem, pattern.span);
    return pattern.source;
  };

  for (const item of file.items) {
    switch (item.kind) {
      case "skip":
        if (skipped) report("skip is already declared", item.span);
        skipped = true;
        skip = item.patterns.map(checked);
        break;
      case "word":
        if (worded) report("word is already declared", item.span);
        worded = true;
        word = checked(item.pattern);
        break;
      case "token": {
        const source = checked(item.pattern);
        if (claim(item.name)) {
          tokenIds.set(item.name.name, tokens.length);
          tokens.push({ name: item.name.name, source, span: item.name.span });
        }
        break;
      }
      case "rule":
        if (claim(item.name)) {
          ruleIds.set(item.name.name, ruleId(declared.length));
          declared.push(item);
        }
        break;
    }
  }

  const isWord = (() => {
    try {
      const re = new RegExp(`^(?:${word})$`);
      return (text: string) => re.test(text);
    } catch {
      return () => false;
    }
  })();

  const suggest = (name: string): string => {
    const known = [...ruleIds.keys(), ...tokenIds.keys(), "ident"];
    const close = known.find((candidate) => levenshteinDistance(candidate, name) <= 2);
    return close ? `; did you mean ${close}?` : "";
  };

  const lowerAlt = (alt: S.Alt): Seq<Located> => ({
    t: "seq",
    span: alt.span,
    ...(alt.tag && { tag: { name: alt.tag.name, span: alt.tag.span } }),
    items: alt.elems.map((elem): Item<Located> => ({
      ...(elem.label && { label: { name: elem.label.name, span: elem.label.span } }),
      keep: false,
      expr: lowerExpr(elem.expr),
    })),
  });

  const lowerExpr = (e: S.Expr): Expr<Located> => {
    switch (e.kind) {
      case "lit":
        if (!e.text) report("A literal cannot be empty", e.span);
        return { t: "lit", text: e.text, kw: e.text !== "" && isWord(e.text), span: e.span };
      case "re":
        return { t: "re", source: checked(e), span: e.span };
      case "cut":
        return { t: "cut", span: e.span };
      case "ref": {
        const { name } = e.name;
        if (name === "ident") return { t: "ident", span: e.span };
        const token = tokenIds.get(name);
        if (token !== undefined) return { t: "re", source: tokens[token]!.source, name, span: e.span };
        const rule = ruleIds.get(name);
        if (rule === undefined) {
          report(`Unknown rule: ${name}${suggest(name)}`, e.span);
          return { t: "cut", span: e.span };
        }
        return { t: "ref", rule, span: e.span };
      }
      case "group":
        return { t: "alt", alts: e.alts.map(lowerAlt), span: e.span };
      case "rep":
        return e.op === "?"
          ? { t: "opt", e: lowerExpr(e.expr), empty: false, span: e.span }
          : { t: e.op === "*" ? "star" : "plus", e: lowerExpr(e.expr), span: e.span };
      case "sep":
        return {
          t: "sep",
          item: lowerExpr(e.item),
          sep: lowerExpr(e.sep),
          min: e.op === "sepBy" || e.op === "sepEndBy" ? 0 : 1,
          trailing: e.op === "sepEndBy" || e.op === "sepEndBy1",
          span: e.span,
        };
      case "pred":
        return { t: e.op === "&" ? "and" : "not", e: lowerExpr(e.expr), span: e.span };
    }
  };

  const levels = (written: readonly S.Level[]): readonly Level<Located>[] => {
    const seen = new Set<string>();
    return written.map(({ assoc, ops }) => ({
      assoc,
      ops: ops.map(({ text, span }): Operator<Located> => {
        const slot = `${assoc === "prefix" || assoc === "postfix" ? assoc : "infix"} ${text}`;
        if (!text) report("An operator cannot be empty", span);
        else if (seen.has(slot)) report(`Operator ${JSON.stringify(text)} is already declared`, span);
        seen.add(slot);
        return { text, kw: text !== "" && isWord(text), span };
      }),
    }));
  };

  const rules = declared.map((item): Rule<Located> => {
    const alts = item.body.kind === "alts" ? item.body.alts : item.body.atoms;
    return {
      name: item.name.name,
      span: item.name.span,
      body: { t: "alt", alts: alts.map(lowerAlt), span: item.name.span },
      ...(item.body.kind === "precedence" && { pratt: levels(item.body.levels) }),
      variants: [],
      pass: [],
      bears: false,
    };
  });

  const keywords = new Set<string>();
  for (const rule of rules) {
    walk(rule.body, (e) => e.t === "lit" && e.kw && keywords.add(e.text));
    for (const level of rule.pratt ?? []) for (const op of level.ops) if (op.kw) keywords.add(op.text);
  }
  if (!rules.length) report("A grammar needs at least one rule", file.name.span);

  return {
    grammar: {
      name: { name: file.name.name, span: file.name.span },
      skip,
      word,
      keywords: [...keywords],
      tokens,
      rules,
    },
    errors,
  };
};
