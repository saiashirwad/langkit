import type { Result } from "langkit";
import {
  choice,
  commit,
  createLexemes,
  lookahead,
  many,
  many1,
  notFollowedBy,
  optional,
  type Parser,
  parseResult,
  regex,
  sepBy,
  sepBy1,
  sepEndBy,
  sepEndBy1,
} from "langkit/parse";
import { makeParser, type Reply, replyFailure, replySuccess, runParser, type SourceText } from "parserator/advanced";
import { memoRules } from "./grammar-analysis.ts";
import {
  type Expr,
  type Level,
  type Operator,
  type RuleId,
  ruleId,
  type Seq,
  walk,
  type Wire,
} from "./grammar-model.ts";

/** A parsed value and where its last token ended, or -1 when it consumed nothing. Node spans are built from it. */
type Cell = { readonly v: unknown; readonly e: number; };
const nothing: Cell = { v: undefined, e: -1 };

const lastEnd = (cells: readonly Cell[]): number => {
  for (let i = cells.length - 1; i >= 0; i--) if (cells[i]!.e >= 0) return cells[i]!.e;
  return -1;
};

const list = (cells: readonly Cell[]): Cell => ({ v: cells.map((cell) => cell.v), e: lastEnd(cells) });

export type Parsers = { readonly parse: (source: string) => Result<unknown>; };

/**
 * Builds parserator parsers from a grammar table, so cuts, backtracking and error messages are parserator's. Rules
 * that begin two sibling alternatives are memoized per input: linear time where plain re-parsing is exponential.
 */
export const define = (grammar: Wire): Parsers => {
  const lex = createLexemes({
    trivia: regex(new RegExp(`(?:${grammar.skip.join("|")})*`)),
    identifier: new RegExp(grammar.word),
    keywords: grammar.keywords,
  });
  const table: Parser<Cell>[] = [];

  const token = (parser: Parser<string>): Parser<Cell> =>
    makeParser((source, offset) => {
      const reply = runParser(parser, source, offset);
      return reply.ok
        ? replySuccess({ v: reply.value, e: offset + reply.value.length }, reply.offset, reply.cut)
        : reply;
    });

  const symbols = new Set<string>();
  for (const rule of grammar.rules) {
    walk(rule.body, (e) => e.t === "lit" && !e.kw && symbols.add(e.text));
    for (const level of rule.pratt ?? []) for (const op of level.ops) if (!op.kw) symbols.add(op.text);
  }

  /** Maximal munch: a symbol yields to any longer symbol of the grammar that also matches at its position. */
  const symbol = (text: string): Parser<string> => {
    const longer = [...symbols].filter((other) => other.length > text.length && other.startsWith(text));
    const plain = lex.symbol(text);
    if (longer.length === 0) return plain;
    return makeParser((source, offset) =>
      longer.some((other) => source.text.startsWith(other, offset))
        ? replyFailure(
          { kind: "expected", span: { start: offset, end: offset }, expected: [JSON.stringify(text)] },
          offset,
        )
        : runParser(plain, source, offset)
    );
  };

  const literal = (text: string, kw: boolean): Parser<string> => kw ? lex.keyword(text) : symbol(text);

  const build = (e: Expr<object>): Parser<Cell> => {
    switch (e.t) {
      case "lit":
        return token(literal(e.text, e.kw));
      case "re": {
        const pattern = lex.token(regex(new RegExp(e.source)));
        return token(e.name ? pattern.expected(e.name) : pattern);
      }
      case "ident":
        return token(lex.identifier);
      case "ref":
        return makeParser((source, offset) => runParser(table[e.rule]!, source, offset));
      case "cut":
        return commit().map(() => nothing);
      case "seq":
        return sequence(e);
      case "alt": {
        const alts = e.alts.map(build);
        return alts.length === 1 ? alts[0]! : choice(...(alts as [Parser<Cell>, ...Parser<Cell>[]]));
      }
      case "star":
        return many(build(e.e)).map(list);
      case "plus":
        return many1(build(e.e)).map(list);
      case "opt": {
        const absent = e.empty ? () => list([]) : () => ({ v: null, e: -1 });
        return optional(build(e.e)).map((cell) => cell ?? absent());
      }
      case "sep": {
        const items = e.min === 0 ? (e.trailing ? sepEndBy : sepBy) : e.trailing ? sepEndBy1 : sepBy1;
        return items(build(e.item), build(e.sep)).map(list);
      }
      case "and":
        return lookahead(build(e.e)).map(() => nothing);
      case "not":
        return notFollowedBy(build(e.e)).map(() => nothing);
    }
  };

  const sequence = (seq: Seq<object>): Parser<Cell> => {
    const parts = seq.items.map((item) => build(item.expr));
    const labels = seq.items.map((item) => item.label?.name === "_" ? undefined : item.label?.name);
    const kept = seq.items.findIndex((item) => item.keep);
    const kind = seq.node;
    return makeParser((source, start) => {
      const cells: Cell[] = new Array(parts.length);
      let offset = start;
      let cut = false;
      let end = -1;
      for (let i = 0; i < parts.length; i++) {
        const reply = runParser(parts[i]!, source, offset);
        if (!reply.ok) return cut && !reply.cut ? { ...reply, cut: true } : reply;
        cells[i] = reply.value;
        if (reply.value.e >= 0) end = reply.value.e;
        offset = reply.offset;
        cut ||= reply.cut;
      }
      if (kind === undefined) {
        return replySuccess(kept < 0 ? { v: undefined, e: end } : { v: cells[kept]!.v, e: end }, offset, cut);
      }
      const node: Record<string, unknown> = { kind };
      for (let i = 0; i < labels.length; i++) if (labels[i] !== undefined) node[labels[i]!] = cells[i]!.v;
      node.span = { start, end: end < 0 ? start : end };
      return replySuccess({ v: node, e: end }, offset, cut);
    });
  };

  type Op = {
    readonly text: string;
    readonly level: number;
    readonly assoc: Level<object>["assoc"];
    readonly bp: number;
    readonly parser: Parser<Cell>;
  };

  /** A Pratt loop: parserator's `precedence` rescans per level and has no `none`, so this is the one parser it lacks. */
  const pratt = (levels: readonly Level<object>[], atom: Parser<Cell>): Parser<Cell> => {
    const ops = levels.flatMap((level, index) =>
      level.ops.map((op: Operator<object>): Op => ({
        text: op.text,
        level: index,
        assoc: level.assoc,
        bp: (index + 1) * 2,
        parser: token(literal(op.text, op.kw)),
      }))
    );
    const longestFirst = (list: readonly Op[]) => list.toSorted((a, b) => b.text.length - a.text.length);
    const prefixes = longestFirst(ops.filter((op) => op.assoc === "prefix"));
    const followers = longestFirst(ops.filter((op) => op.assoc !== "prefix"));

    type Matched = { readonly op: Op; readonly reply: Extract<Reply<Cell>, { readonly ok: true; }>; };
    const match = (candidates: readonly Op[], source: SourceText, offset: number): Matched | undefined => {
      for (const op of candidates) {
        const reply = runParser(op.parser, source, offset);
        if (reply.ok) return { op, reply };
      }
      return undefined;
    };

    const node = (kind: string, op: Op, fields: Record<string, unknown>, start: number, end: number): Cell => ({
      v: { kind, operator: op.text, ...fields, span: { start, end } },
      e: end,
    });

    const expression = (source: SourceText, start: number, minimum: number): Reply<Cell> => {
      let value: Cell;
      let offset: number;
      let cut: boolean;
      const prefix = match(prefixes, source, start);
      if (prefix) {
        const operand = expression(source, prefix.reply.offset, prefix.op.bp);
        if (!operand.ok) return prefix.reply.cut && !operand.cut ? { ...operand, cut: true } : operand;
        value = node("prefix", prefix.op, { operand: operand.value.v }, start, operand.value.e);
        offset = operand.offset;
        cut = prefix.reply.cut || operand.cut;
      } else {
        const first = runParser(atom, source, start);
        if (!first.ok) return first;
        value = first.value;
        offset = first.offset;
        cut = first.cut;
      }
      for (;;) {
        const next = match(followers, source, offset);
        if (!next || next.op.bp < minimum) return replySuccess(value, offset, cut);
        const { op, reply } = next;
        if (op.assoc === "postfix") {
          value = node("postfix", op, { operand: value.v }, start, reply.value.e);
          offset = reply.offset;
          cut ||= reply.cut;
          continue;
        }
        const right = expression(source, reply.offset, op.assoc === "right" ? op.bp : op.bp + 1);
        cut ||= reply.cut;
        if (!right.ok) return cut && !right.cut ? { ...right, cut: true } : right;
        value = node("binary", op, { left: value.v, right: right.value.v }, start, right.value.e);
        offset = right.offset;
        cut ||= right.cut;
        if (op.assoc === "none") {
          const again = match(followers, source, offset);
          if (again && again.op.level === op.level) {
            return replyFailure(
              {
                kind: "custom",
                span: { start: offset, end: offset + again.op.text.length },
                message: `${op.text} cannot be chained; add parentheses`,
              },
              offset,
              true,
            );
          }
        }
      }
    };
    return makeParser((source, offset) => expression(source, offset, 0));
  };

  const memoized = memoRules(grammar);
  const memos = new WeakMap<SourceText, Map<number, Reply<Cell>>[]>();
  const memoize = (id: RuleId, parser: Parser<Cell>): Parser<Cell> =>
    makeParser((source, offset) => {
      let perRule = memos.get(source);
      if (!perRule) memos.set(source, perRule = []);
      const cache = (perRule[id] ??= new Map());
      const hit = cache.get(offset);
      if (hit) return hit;
      const reply = runParser(parser, source, offset);
      cache.set(offset, reply);
      return reply;
    });

  grammar.rules.forEach((rule, index) => {
    const id = ruleId(index);
    const atom = build(rule.body);
    const parser = rule.pratt ? pratt(rule.pratt, atom) : atom;
    table[id] = memoized.has(id) ? memoize(id, parser) : parser;
  });

  const program = lex.complete(table[0]!.map((cell) => cell.v));
  return { parse: (source) => parseResult(program, source) };
};
