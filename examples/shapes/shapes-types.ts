// Row inference adapted from the rows example; independent language policy.
import { type Check, check, fail } from "langkit";
import { add, assign, pruneLink } from "langkit/inference";
import type { Binding } from "langkit/ir";
const atomic = <A>(computation: Check<A>): Check<A> => computation.atomic();
export type Type =
  | { readonly kind: "number" | "boolean" | "string"; }
  | { readonly kind: "function"; readonly param: Type; readonly result: Type; }
  | { readonly kind: "record"; readonly row: Row; readonly shape?: ShapeName; }
  | Variable;

export type ShapeName = { readonly name: string; readonly fields: ReadonlyMap<string, string>; };

// Only closed, variable-free fields can be hidden without losing specialization or sharing.
export const named = (type: Type, name: string): Type => {
  if (type.kind !== "record") return type;
  const fields = new Map<string, string>();
  for (const [label, field] of flatten(type.row).fields) {
    if (free(field).size) return type;
    fields.set(label, show(field));
  }
  return { ...type, shape: { name, fields } };
};

type Variable = { readonly kind: "variable"; instance?: Type; };

export type RowVariable = { readonly kind: "row-variable"; readonly lacks: Set<string>; instance?: Row; };

type Row = { readonly fields: ReadonlyMap<string, Type>; readonly tail: RowVariable | null; };

type FreeVariable = Variable | RowVariable;

type Scheme = { readonly type: Type; readonly variables: ReadonlySet<FreeVariable>; };

export type Entry = { readonly binding: Binding<Type>; readonly scheme: Scheme; };

export const number: Type = { kind: "number" };
export const boolean: Type = { kind: "boolean" };
export const string: Type = { kind: "string" };

export const fn = (param: Type, result: Type): Type => ({ kind: "function", param, result });

export const record = (row: Row): Type => ({ kind: "record", row });

export const row = (
  fields: ReadonlyMap<string, Type> = new Map(),
  tail: RowVariable | null = null,
): Row => ({ fields, tail });

export const fresh = (): Check<Variable> =>
  check(function*() {
    return { kind: "variable" };
  });

export const freshRow = (lacks: Iterable<string> = []): Check<RowVariable> =>
  check(function*() {
    return { kind: "row-variable", lacks: new Set(lacks) };
  });

const typeVariable = (value: Type): Variable | null => value.kind === "variable" ? value : null;
const typeInstance = (variable: Variable): Type | undefined => variable.instance;

export const prune = (type: Type): Type => pruneLink(type, typeVariable, typeInstance);
export const flatten = (input: Row): Row => {
  const fields = new Map(input.fields);
  let tail = input.tail;
  while (tail?.instance) {
    for (const [name, type] of tail.instance.fields) fields.set(name, type);
    tail = tail.instance.tail;
  }
  return row(fields, tail);
};

type Display = {
  readonly compact: string;
  readonly alias?: string;
  readonly fields?: readonly (readonly [string, Display])[];
  readonly tail?: string;
  readonly param?: Display;
  readonly result?: Display;
};

const displayWidth = 80;

// Prefix/suffix widths are included so nesting does not overflow an otherwise fitting line.
const layout = (node: Display, indent = 0, prefix = "", suffix = ""): string => {
  const pad = " ".repeat(indent);
  if (indent + prefix.length + node.compact.length + suffix.length <= displayWidth) {
    return pad + prefix + node.compact + suffix;
  }
  if (node.fields) {
    const lines = [pad + prefix + (node.alias ? node.alias + " & " : "") + "{"];
    for (const [index, [name, value]] of node.fields.entries()) {
      lines.push(layout(value, indent + 2, `${name}: `, index < node.fields.length - 1 || node.tail ? "," : ""));
    }
    if (node.tail) lines.push(`${pad}  ..${node.tail}`);
    lines.push(pad + "}" + suffix);
    return lines.join("\n");
  }
  if (node.param && node.result) {
    // Parenthesize the whole chain when nested, retaining higher-order grouping.
    const nested = prefix.length > 0 || suffix.length > 0;
    const lines: string[] = nested ? [pad + prefix + "("] : [];
    const depth = indent + (nested ? 2 : 0);
    let current = node;
    while (current.param && current.result) {
      const parameter = layout(current.param, depth, "", " ->");
      const rest: string[] = [];
      let tail = current.result;
      while (tail.param && tail.result) {
        rest.push(tail.param.compact);
        tail = tail.result;
      }
      rest.push(tail.compact);
      const remaining = rest.join(" -> ");
      const lastLine = parameter.slice(parameter.lastIndexOf("\n") + 1);
      if (lastLine.length + 1 + remaining.length <= displayWidth) {
        lines.push(parameter + " " + remaining);
        if (nested) lines.push(pad + ")" + suffix);
        return lines.join("\n");
      }
      lines.push(parameter);
      current = current.result;
    }
    lines.push(layout(current, depth));
    if (nested) lines.push(pad + ")" + suffix);
    return lines.join("\n");
  }
  // Identifiers are indivisible: never truncate a long field or variable name.
  return pad + prefix + node.compact + suffix;
};

export const show = (type: Type): string => {
  const names = new Map<Variable, string>();
  const rows = new Map<RowVariable, string>();
  const implied = new Map<RowVariable, Set<string>>();
  const occurrences = new Map<RowVariable, number>();
  const count = (input: Type): void => {
    const t = prune(input);
    if (t.kind === "function") {
      count(t.param);
      count(t.result);
    }
    if (t.kind === "record") {
      const { fields, tail } = flatten(t.row);
      if (tail) occurrences.set(tail, (occurrences.get(tail) ?? 0) + 1);
      for (const field of fields.values()) count(field);
    }
  };
  count(type);
  const visit = (type: Type): Display => {
    type = prune(type);
    if (type.kind === "function") {
      const param = visit(type.param);
      const result = visit(type.result);
      return { compact: `(${param.compact} -> ${result.compact})`, param, result };
    }
    if (type.kind === "record") {
      const { fields, tail } = flatten(type.row);
      const alias = tail && type.shape && [...type.shape.fields].every(([label, baseline]) => {
          const field = fields.get(label);
          return field && !free(field).size && show(field) === baseline;
        })
        ? type.shape
        : undefined;
      const entries = [...fields]
        .filter(([label]) => !alias?.fields.has(label))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, type]) => [name, visit(type)] as const);
      const labels = entries.map(([name, value]) => `${name}: ${value.compact}`);
      if (tail) {
        if (!rows.has(tail)) rows.set(tail, `r${rows.size || ""}`);
        const visible = implied.get(tail) ?? new Set<string>();
        for (const label of fields.keys()) visible.add(label);
        implied.set(tail, visible);
        const showTail = !alias || (occurrences.get(tail) ?? 0) > 1
          || [...tail.lacks].some(label => !fields.has(label));
        if (alias && !labels.length && !showTail) return { compact: alias.name };
        const remainder = `{ ${labels.join(", ")}${
          showTail ? `${labels.length ? ", " : ""}..${rows.get(tail)}` : ""
        } }`;
        return {
          compact: alias
            ? `${alias.name} & ${remainder}`
            : `{ ${labels.join(", ")}${labels.length ? ", " : ""}..${rows.get(tail)} }`,
          ...(alias ? { alias: alias.name } : {}),
          fields: entries,
          ...(showTail ? { tail: rows.get(tail)! } : {}),
        };
      }
      return { compact: labels.length ? `{ ${labels.join(", ")} }` : "{}", fields: entries };
    }
    if (type.kind !== "variable") return { compact: type.kind };
    if (!names.has(type)) {
      const index = names.size;
      names.set(
        type,
        String.fromCharCode(97 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : ""),
      );
    }
    return { compact: names.get(type)! };
  };
  const result = visit(type);
  const constraints = [...rows]
    .map(([variable, name]) => ({
      name,
      labels: [...variable.lacks].filter(label => !implied.get(variable)?.has(label)).sort(),
    }))
    .filter(({ labels }) => labels.length);
  const compact = result.compact + (constraints.length
    ? ` where ${constraints.map(({ name, labels }) => `${name} lacks ${labels.join(", ")}`).join("; ")}`
    : "");
  if (compact.length <= displayWidth) return compact;
  const lines = [layout(result)];
  if (constraints.length) lines.push("where");
  for (const { name, labels } of constraints) {
    let line = `  ${name} lacks`;
    for (const [index, label] of labels.entries()) {
      const text = label + (index < labels.length - 1 ? "," : "");
      if (line.length + 1 + text.length > displayWidth) {
        lines.push(line);
        line = `    ${text}`;
      } else line += ` ${text}`;
    }
    lines.push(line);
  }
  return lines.join("\n");
};

export const freeRow = (input: Row, found: Set<FreeVariable>): void => {
  const { fields, tail } = flatten(input);
  for (const type of fields.values()) free(type, found);
  if (tail) found.add(tail);
};

export const free = (type: Type, found = new Set<FreeVariable>()): Set<FreeVariable> => {
  type = prune(type);
  if (type.kind === "variable") found.add(type);
  else if (type.kind === "function") {
    free(type.param, found);
    free(type.result, found);
  } else if (type.kind === "record") freeRow(type.row, found);
  return found;
};

// Every row tail excludes its explicit fields. Extension adds absence constraints;
// solving a row variable checks and propagates them, including through aliases.
export const exclude = (input: Row, labels: Iterable<string>): Check<void> =>
  atomic(check(function*() {
    const { fields, tail } = flatten(input);
    for (const label of labels) {
      if (fields.has(label)) return yield* fail(`Duplicate field: ${label}`);
      if (tail) yield* add(tail.lacks, label);
    }
  }));

export const solveRow = (variable: RowVariable, input: Row): Check<void> =>
  atomic(check(function*() {
    const target = flatten(input);
    if (!target.fields.size && target.tail === variable) return;
    const variables = new Set<FreeVariable>();
    freeRow(target, variables);
    if (variables.has(variable)) return yield* fail("Infinite row");
    yield* exclude(target, variable.lacks);
    if (target.tail) { for (const label of target.fields.keys()) yield* add(target.tail.lacks, label); }
    yield* assign(variable, "instance", target);
  }));

export const unifyRows = (left: Row, right: Row): Check<void> =>
  atomic(check(function*() {
    let a = flatten(left);
    let b = flatten(right);
    const unified = new Set<string>();
    while (true) {
      const common = [...a.fields].filter(([label]) => b.fields.has(label) && !unified.has(label));
      if (!common.length) break;
      for (const [label, type] of common) {
        yield* unify(type, b.fields.get(label)!);
        unified.add(label);
      }
      a = flatten(left);
      b = flatten(right);
    }
    const onlyA = new Map([...a.fields].filter(([label]) => !b.fields.has(label)));
    const onlyB = new Map([...b.fields].filter(([label]) => !a.fields.has(label)));
    if ((!a.tail && onlyB.size) || (!b.tail && onlyA.size)) {
      return yield* fail(`Missing field: ${[...(!a.tail ? onlyB : onlyA).keys()].join(", ")}`);
    }
    if (a.tail === b.tail) {
      if (onlyA.size || onlyB.size) {
        return yield* fail("Infinite row: incompatible fields share a tail");
      }
      return;
    }
    if (a.tail && b.tail) {
      const shared = yield* freshRow();
      yield* solveRow(a.tail, row(onlyB, shared));
      yield* solveRow(b.tail, row(onlyA, shared));
    } else if (a.tail) yield* solveRow(a.tail, row(onlyB));
    else if (b.tail) yield* solveRow(b.tail, row(onlyA));
  }));

export const unify = (left: Type, right: Type): Check<void> =>
  atomic(check(function*() {
    const a = prune(left);
    const b = prune(right);
    if (a === b) return;
    if (a.kind === "variable") {
      if (free(b).has(a)) return yield* fail(`Infinite type: ${show(a)} occurs in ${show(b)}`);
      yield* assign(a, "instance", b);
    } else if (b.kind === "variable") yield* unify(b, a);
    else if (a.kind === "function" && b.kind === "function") {
      yield* unify(a.param, b.param);
      yield* unify(a.result, b.result);
    } else if (a.kind === "record" && b.kind === "record") yield* unifyRows(a.row, b.row);
    else if (a.kind !== b.kind) return yield* fail(`Cannot unify ${show(a)} with ${show(b)}`);
  }));

export const mono = (type: Type): Scheme => ({ type, variables: new Set() });

export const generalize = (type: Type, environment: ReadonlyMap<string, Entry>): Check<Scheme> =>
  check(function*() {
    const variables = free(type);
    for (const { scheme } of environment.values()) {
      for (const variable of free(scheme.type)) {
        if (!scheme.variables.has(variable)) variables.delete(variable);
      }
    }
    return { type, variables };
  });

export const instantiate = (scheme: Scheme): Check<Type> =>
  check(function*() {
    const replacements = new Map<Variable, Variable>();
    const rows = new Map<RowVariable, RowVariable>();
    const visitRow = function*(input: Row): Generator<Check<unknown>, Row, unknown> {
      const flat = flatten(input);
      let tail = flat.tail;
      if (tail && scheme.variables.has(tail)) {
        if (!rows.has(tail)) rows.set(tail, yield* freshRow(tail.lacks));
        tail = rows.get(tail)!;
      }
      const fields = new Map<string, Type>();
      for (const [name, type] of flat.fields) fields.set(name, yield* visit(type));
      return row(fields, tail);
    };
    const visit = function*(input: Type): Generator<Check<unknown>, Type, unknown> {
      const type = prune(input);
      if (type.kind === "function") return fn(yield* visit(type.param), yield* visit(type.result));
      if (type.kind === "record") return { ...type, row: yield* visitRow(type.row) };
      if (type.kind !== "variable" || !scheme.variables.has(type)) return type;
      if (!replacements.has(type)) replacements.set(type, yield* fresh());
      return replacements.get(type)!;
    };
    return yield* visit(scheme.type);
  });
