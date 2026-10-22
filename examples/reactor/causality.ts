import type { Span } from "langkit";
import type { Expr, Formula, Node, Pattern, Slot } from "./reactor-model.ts";

/** `from` reads `to` in the same tick, at `span`. */
export type Read = { readonly from: Node; readonly to: Slot; readonly span: Span; };

type Found = { readonly to: Slot; readonly span: Span; };

const inExpr = (expr: Expr): readonly Found[] => {
  switch (expr.kind) {
    case "ref":
      return expr.ref.kind === "slot" ? [{ to: expr.ref.slot, span: expr.span }] : [];
    case "field":
      return inExpr(expr.record);
    case "member":
      return [];
    case "variant":
      return expr.args.flatMap(inExpr);
    case "record":
      return expr.fields.flatMap(([, value]) => value ? inExpr(value) : []);
    case "list":
      return expr.items.flatMap(({ value }) => inExpr(value));
  }
};

const inPattern = (pattern: Pattern): readonly Found[] => {
  switch (pattern.kind) {
    case "wild":
    case "bind":
    case "member":
      return [];
    case "equal":
      return pattern.ref.kind === "slot" ? [{ to: pattern.ref.slot, span: pattern.span }] : [];
    case "variant":
      return (pattern.args ?? []).flatMap(inPattern);
    case "record":
      return pattern.fields.flatMap(([, nested]) => inPattern(nested));
    case "tuple":
      return pattern.items.flatMap(inPattern);
    case "spread":
      return [...pattern.head, ...pattern.tail].flatMap(inPattern);
  }
};

const inFormula = (formula: Formula): readonly Found[] => {
  switch (formula.kind) {
    case "is":
    case "contains":
      return [...inExpr(formula.subject), ...inPattern(formula.pattern)];
    case "and":
    case "or":
      return [...inFormula(formula.left), ...inFormula(formula.right)];
    case "not":
      return inFormula(formula.operand);
  }
};

/**
 * What a node reads this tick. A signal reads its `if` cells and its arrow; a value cell reads each group's
 * signal and whatever its rows name. Matching on a cell's own value is not a read, since that is the state the
 * tick starts from; naming the cell inside its rows is. An initial value and a `last` cell read nothing.
 */
const readsOf = (node: Node): readonly Found[] => {
  if (node.kind === "signal") {
    return [...node.present.map(({ slot, span }) => ({ to: slot, span })), ...inExpr(node.value)];
  }
  if (node.init.kind === "last") return [];
  return node.init.groups.flatMap(({ source, on, rows }) => [
    ...source.kind === "signal" ? [{ to: source, span: on }] : [],
    ...rows.flatMap(({ pattern, guard, value }) => [
      ...inPattern(pattern),
      ...guard ? inFormula(guard.formula) : [],
      ...inExpr(value),
    ]),
  ]);
};

/** A dependency cycle, as the reads around it starting at its earliest declared node. */
export type Cycle = readonly [Read, ...Read[]];

export type Causality = {
  /** Every node after the nodes it reads, which is the order a tick evaluates them in. */
  readonly order: readonly Node[];
  readonly cycles: readonly Cycle[];
};

/** Tarjan's strongly connected components over the reads: O(nodes + reads), one cycle per component. */
export const causality = (nodes: readonly Node[]): Causality => {
  const bySlot = new Map(nodes.map((node) => [node.slot as Slot, node]));
  const edges = new Map(nodes.map((node) => [
    node,
    readsOf(node).flatMap(({ to, span }): Read[] => bySlot.has(to) ? [{ from: node, to, span }] : []),
  ]));
  const index = new Map<Node, number>();
  const low = new Map<Node, number>();
  const stack: Node[] = [];
  const onStack = new Set<Node>();
  const order: Node[] = [];
  const components: Node[][] = [];
  const visit = (node: Node): void => {
    index.set(node, index.size);
    low.set(node, index.get(node)!);
    stack.push(node);
    onStack.add(node);
    for (const { to } of edges.get(node)!) {
      const next = bySlot.get(to)!;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const component: Node[] = [];
    let member: Node;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    order.push(...component);
    components.push(component);
  };
  for (const node of nodes) if (!index.has(node)) visit(node);

  const cycles = components.flatMap((component): Cycle[] => {
    const start = nodes.find((node) => component.includes(node))!;
    const self = edges.get(start)!.find(({ to }) => to === start.slot);
    if (self) return [[self]];
    if (component.length === 1) return [];
    const path = (at: Node, seen: ReadonlySet<Node>): Read[] | undefined => {
      for (const read of edges.get(at)!) {
        const next = bySlot.get(read.to)!;
        if (next === start) return [read];
        if (!component.includes(next) || seen.has(next)) continue;
        const rest = path(next, new Set(seen).add(next));
        if (rest) return [read, ...rest];
      }
      return undefined;
    };
    const [first, ...rest] = path(start, new Set([start]))!;
    return [[first!, ...rest]];
  });
  return { order, cycles };
};
