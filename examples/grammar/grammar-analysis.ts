import type { Span } from "langkit";
import {
  type Checked,
  type Expr,
  type Grammar,
  type Located,
  type RuleId,
  ruleId,
  type Seq,
  walk,
} from "./grammar-model.ts";

type Shadow = "always succeeds" | "same alternative" | "prefix" | "commits";

export type Finding =
  | { readonly kind: "left recursion"; readonly cycle: readonly RuleId[]; readonly sites: readonly Span[]; }
  | { readonly kind: "nullable loop"; readonly span: Span; readonly loop: "repeat" | "separated"; }
  | { readonly kind: "shadowed"; readonly alt: Span; readonly why: Shadow; }
  | { readonly kind: "unused rule"; readonly rule: RuleId; }
  | { readonly kind: "unused token"; readonly name: string; readonly span: Span; };

type Site = { readonly rule: RuleId; readonly span: Span; };

const fixpoint = (grammar: Grammar<object>, step: (state: readonly boolean[], rule: RuleId) => boolean) => {
  const state = grammar.rules.map(() => false);
  for (let changed = true; changed;) {
    changed = false;
    grammar.rules.forEach((_, index) => {
      if (!state[index] && step(state, ruleId(index))) {
        state[index] = true;
        changed = true;
      }
    });
  }
  return state;
};

/** Can `e` succeed without consuming input? Exact without predicates; with them, a sound over-approximation. */
const nullable = (e: Expr<object>, rules: readonly boolean[]): boolean => {
  switch (e.t) {
    case "lit":
    case "re":
    case "ident":
      return false;
    case "ref":
      return rules[e.rule]!;
    case "cut":
    case "and":
    case "not":
    case "star":
    case "opt":
      return true;
    case "plus":
      return nullable(e.e, rules);
    case "sep":
      return e.min === 0 || nullable(e.item, rules);
    case "seq":
      return e.items.every((item) => nullable(item.expr, rules));
    case "alt":
      return e.alts.some((alt) => nullable(alt, rules));
  }
};

export const nullableRules = (grammar: Grammar<object>): readonly boolean[] =>
  fixpoint(grammar, (state, id) => nullable(grammar.rules[id]!.body, state));

/** Does `e` succeed at every input position? Exact: shadowing relies on it. */
const total = (e: Expr<object>, rules: readonly boolean[]): boolean => {
  switch (e.t) {
    case "lit":
    case "re":
    case "ident":
    case "not":
      return false;
    case "ref":
      return rules[e.rule]!;
    case "cut":
    case "star":
    case "opt":
      return true;
    case "and":
    case "plus":
      return total(e.e, rules);
    case "sep":
      return e.min === 0 || total(e.item, rules);
    case "seq":
      return e.items.every((item) => total(item.expr, rules));
    case "alt":
      return e.alts.some((alt) => total(alt, rules));
  }
};

const totalRules = (grammar: Grammar<object>): readonly boolean[] =>
  fixpoint(grammar, (state, id) => total(grammar.rules[id]!.body, state));

/** Rules `e` may call before consuming any input. */
const leftCalls = (e: Expr<Located>, rules: readonly boolean[]): readonly Site[] => {
  switch (e.t) {
    case "ref":
      return [{ rule: e.rule, span: e.span }];
    case "seq": {
      const calls: Site[] = [];
      for (const item of e.items) {
        calls.push(...leftCalls(item.expr, rules));
        if (!nullable(item.expr, rules)) break;
      }
      return calls;
    }
    case "alt":
      return e.alts.flatMap((alt) => leftCalls(alt, rules));
    case "star":
    case "plus":
    case "opt":
    case "and":
    case "not":
      return leftCalls(e.e, rules);
    case "sep":
      return [...leftCalls(e.item, rules), ...(nullable(e.item, rules) ? leftCalls(e.sep, rules) : [])];
    case "lit":
    case "re":
    case "ident":
    case "cut":
      return [];
  }
};

const components = (edges: readonly (readonly Site[])[]): readonly (readonly RuleId[])[] => {
  const index: number[] = [];
  const low: number[] = [];
  const onStack: boolean[] = [];
  const stack: RuleId[] = [];
  const out: RuleId[][] = [];
  let counter = 0;
  const visit = (v: RuleId): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const { rule: w } of edges[v]!) {
      if (index[w] === undefined) {
        visit(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) {
      const component: RuleId[] = [];
      for (let w: RuleId | undefined; w !== v;) {
        w = stack.pop()!;
        onStack[w] = false;
        component.push(w);
      }
      out.push(component.sort((a, b) => a - b));
    }
  };
  edges.forEach((_, v) => index[v] === undefined && visit(ruleId(v)));
  return out.sort((a, b) => a[0]! - b[0]!);
};

/** The shortest call path from the component's first rule back to itself, with the call site of each step. */
const cycleIn = (component: readonly RuleId[], edges: readonly (readonly Site[])[]): Finding => {
  const inside = new Set(component);
  const start = component[0]!;
  const previous = new Map<RuleId, { readonly from: RuleId; readonly span: Span; }>();
  const queue = [start];
  for (const v of queue) {
    for (const { rule, span } of edges[v]!) {
      if (!inside.has(rule)) continue;
      if (rule === start) {
        const cycle: RuleId[] = [];
        const sites: Span[] = [span];
        for (let at = v; at !== start; at = previous.get(at)!.from) {
          cycle.unshift(at);
          sites.unshift(previous.get(at)!.span);
        }
        return { kind: "left recursion", cycle: [start, ...cycle], sites };
      }
      if (!previous.has(rule)) {
        previous.set(rule, { from: v, span });
        queue.push(rule);
      }
    }
  }
  throw new Error("component without a cycle");
};

const canon = (e: Expr<object>): string => {
  switch (e.t) {
    case "lit":
      return `${e.kw ? "k" : "s"}${JSON.stringify(e.text)}`;
    case "re":
      return `/${e.source}/`;
    case "ident":
      return "ident";
    case "ref":
      return `@${e.rule}`;
    case "cut":
      return "~";
    case "seq":
      return `(${e.items.map((item) => canon(item.expr)).join(" ")})`;
    case "alt":
      return `[${e.alts.map(canon).join("|")}]`;
    case "opt":
    case "star":
    case "plus":
    case "and":
    case "not":
      return `${e.t}(${canon(e.e)})`;
    case "sep":
      return `sep${e.min}${e.trailing ? "e" : ""}(${canon(e.item)},${canon(e.sep)})`;
  }
};

const sticky = (source: string, text: string): boolean => new RegExp(source, "y").test(text);
const isWordCharacter = (character: string | undefined): boolean => character !== undefined && /\w/.test(character);

/**
 * `exact` consumes what the other consumes. `proper` succeeds wherever the other does but may stop elsewhere,
 * which is only safe for the last element of a prefix.
 */
type Cover = "exact" | "proper";

type Shadowing = { readonly grammar: Grammar<object>; readonly total: readonly boolean[]; };

const single = (e: Expr<object>): Expr<object> => {
  if (e.t === "seq" && e.items.length === 1) return single(e.items[0]!.expr);
  if (e.t === "alt" && e.alts.length === 1) return single(e.alts[0]!);
  return e;
};

/** Sound, not complete: `undefined` means no proof, not a proof of independence. */
const cover = (context: Shadowing, a: Expr<object>, b: Expr<object>): Cover | undefined => {
  if (canon(a) === canon(b)) return "exact";
  const [x, y] = [single(a), single(b)];
  if (x !== a || y !== b) return cover(context, x, y);
  if (b.t === "alt") {
    const covers = b.alts.map((alt) => cover(context, a, alt));
    return covers.every((c) => c !== undefined) ? covers.every((c) => c === "exact") ? "exact" : "proper" : undefined;
  }
  switch (a.t) {
    case "alt": {
      const covers = a.alts.map((alt) => cover(context, alt, b));
      return covers.includes("exact") ? "exact" : covers.includes("proper") ? "proper" : undefined;
    }
    case "opt":
      return cover(context, a.e, b) === "exact" ? "exact" : "proper";
    case "star":
      return "proper";
    case "plus":
      return cover(context, a.e, b.t === "plus" ? b.e : b) && "proper";
    case "sep":
      if (a.min === 0) return "proper";
      return cover(context, a.item, b.t === "sep" ? b.item : b) && "proper";
    case "lit":
      if (b.t !== "lit" || !b.text.startsWith(a.text)) return undefined;
      return a.kw && isWordCharacter(b.text[a.text.length]) ? undefined : "proper";
    case "re":
      return b.t === "lit" && sticky(a.source, b.text) ? "proper" : undefined;
    case "ident":
      return b.t === "lit" && !b.kw && sticky(context.grammar.word, b.text) ? "proper" : undefined;
    case "ref":
    case "and":
    case "not":
    case "cut":
    case "seq":
      return total(a, context.total) ? "proper" : undefined;
  }
};

/** A rule with one alternative reads as its items, so `A = B | "x" "y"` with `B = "x"` is seen as `"x" | "x" "y"`. */
const flat = (
  grammar: Grammar<object>,
  items: readonly Expr<object>[],
  seen = new Set<RuleId>(),
): readonly Expr<object>[] => {
  const head = items[0];
  if (head?.t !== "ref" || seen.has(head.rule) || seen.size >= 4) return items;
  const rule = grammar.rules[head.rule]!;
  if (rule.pratt || rule.body.alts.length !== 1) return items;
  const inner = rule.body.alts[0]!.items.map((item) => item.expr);
  return flat(grammar, [...inner, ...items.slice(1)], new Set(seen).add(head.rule));
};

const subsumes = (context: Shadowing, prefix: readonly Expr<object>[], lead: readonly Expr<object>[]): boolean => {
  if (!prefix.length || prefix.length > lead.length) return false;
  return prefix.every((item, index) => {
    const covered = cover(context, item, lead[index]!);
    return covered === "exact" || (covered === "proper" && index === prefix.length - 1);
  });
};

/** Does every input that `later` matches already succeed, or commit, in `earlier`? */
const dominates = (context: Shadowing, earlier: Seq<object>, later: Seq<object>): Shadow | undefined => {
  if (total(earlier, context.total)) return "always succeeds";
  const items = flat(context.grammar, earlier.items.map((item) => item.expr));
  const lead = flat(context.grammar, later.items.map((item) => item.expr)).filter((e) => e.t !== "cut");
  const cut = items.findIndex((e) => e.t === "cut");
  if (cut === 0) return "commits";
  const prefix = cut < 0 ? items : items.slice(0, cut);
  if (!subsumes(context, prefix, lead)) return undefined;
  if (cut >= 0) return "commits";
  return prefix.length === lead.length && canon(earlier) === canon(later) ? "same alternative" : "prefix";
};

const references = (
  grammar: Checked,
): { readonly rules: ReadonlySet<RuleId>; readonly tokens: ReadonlySet<string>; } => {
  const rules = new Set<RuleId>([ruleId(0)]);
  const tokens = new Set<string>();
  const queue = [ruleId(0)];
  for (const id of queue) {
    walk(grammar.rules[id]!.body, (e) => {
      if (e.t === "re" && e.name) tokens.add(e.name);
      if (e.t === "ref" && !rules.has(e.rule)) {
        rules.add(e.rule);
        queue.push(e.rule);
      }
    });
  }
  return { rules, tokens };
};

/** Pure graph passes over the checked IR: nullable and total fixpoints, left-call SCCs, loops, dominance, reachability. */
export const audit = (grammar: Checked): readonly Finding[] => {
  if (!grammar.rules.length) return [];
  const findings: Finding[] = [];
  const nullables = nullableRules(grammar);
  const totals = totalRules(grammar);
  const context: Shadowing = { grammar, total: totals };

  const edges = grammar.rules.map((rule) => leftCalls(rule.body, nullables));
  for (const component of components(edges)) {
    const self = component.length === 1 && edges[component[0]!]!.some((edge) => edge.rule === component[0]);
    if (component.length > 1 || self) findings.push(cycleIn(component, edges));
  }

  for (const rule of grammar.rules) {
    walk(rule.body, (e) => {
      if ((e.t === "star" || e.t === "plus") && nullable(e.e, nullables)) {
        findings.push({ kind: "nullable loop", span: e.span, loop: "repeat" });
      }
      if (e.t === "sep" && nullable(e.item, nullables)) {
        findings.push({ kind: "nullable loop", span: e.span, loop: "separated" });
      }
      if (e.t === "alt") {
        e.alts.forEach((later, j) => {
          for (let i = 0; i < j; i++) {
            const why = dominates(context, e.alts[i]!, later);
            if (why) {
              findings.push({ kind: "shadowed", alt: later.span, why });
              return;
            }
          }
        });
      }
    });
  }

  const used = references(grammar);
  grammar.rules.forEach((_, id) =>
    used.rules.has(ruleId(id)) || findings.push({ kind: "unused rule", rule: ruleId(id) })
  );
  for (const { name, span } of grammar.tokens) {
    if (!used.tokens.has(name)) findings.push({ kind: "unused token", name, span });
  }
  return findings;
};

/**
 * Rules that begin two sibling alternatives of one choice. Each re-parses the shared rule at the same offset, which
 * compounds with nesting, so the runtime memoizes exactly these rules.
 */
export const memoRules = (grammar: Grammar<object>): ReadonlySet<RuleId> => {
  const heads = (e: Expr<object>): RuleId | undefined => {
    switch (e.t) {
      case "ref":
        return e.rule;
      case "seq": {
        const first = e.items.find((item) => item.expr.t !== "cut");
        return first && heads(first.expr);
      }
      default:
        return undefined;
    }
  };
  const memo = new Set<RuleId>();
  for (const rule of grammar.rules) {
    walk(rule.body, (e) => {
      if (e.t !== "alt") return;
      const counts = new Map<RuleId, number>();
      for (const alt of e.alts) {
        const head = heads(alt);
        if (head !== undefined) counts.set(head, (counts.get(head) ?? 0) + 1);
      }
      for (const [head, count] of counts) if (count > 1) memo.add(head);
    });
  }
  return memo;
};
