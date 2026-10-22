import { type Check, check } from "langkit";
import {
  assignable,
  type DataType,
  type Enum,
  type EnumMember,
  type Field,
  type Name,
  showType,
  type Tagged,
  type TypeDecl,
  type Universe,
  type Variant,
} from "../data/data-model.ts";
import { attempt, error, facts, type Scope } from "../data/data-types.ts";
import { atLeast, exactly, intersect, type Lengths, longest, rest, upTo } from "./lengths.ts";
import type { Expr, Formula, Input, Local, Pattern, Slot } from "./reactor-model.ts";
import type * as G from "./reactor.grammar";

export type Constructor =
  | { readonly kind: "member"; readonly of: Enum; readonly member: EnumMember; }
  | { readonly kind: "variant"; readonly of: Tagged; readonly variant: Variant; };

/** Every member and variant by name. Two enums may share a member name; the expected type picks one. */
export type Constructors = ReadonlyMap<string, readonly Constructor[]>;

export const constructors = (universe: Universe): Constructors => {
  const found = new Map<string, Constructor[]>();
  const add = (name: Name, constructor: Constructor) =>
    found.set(name.name, [...found.get(name.name) ?? [], constructor]);
  for (const type of universe.values()) {
    if (type.kind === "enum") {
      for (const member of type.members) add(member.name, { kind: "member", of: type, member });
    }
    if (type.kind === "tagged") {
      for (const variant of type.variants) add(variant.name, { kind: "variant", of: type, variant });
    }
  }
  return found;
};

const constructorName = (constructor: Constructor): Name =>
  constructor.kind === "member" ? constructor.member.name : constructor.variant.name;

/** `Half is a member of Feel`, `Loop is a variant of Step`. */
export const describe = (constructor: Constructor): string =>
  `${constructorName(constructor).name} is a ${constructor.kind} of ${constructor.of.name.name}`;

export type Entity = Input | Slot;

/**
 * When a value is computed, which decides what it may read: `initial` is before any tick, so nothing; `tick` is
 * a row, guard or signal arrow, so every cell and signal; `property` is a reachable state, so cells only.
 */
export type Moment = "initial" | "tick" | "property";

export type Env = {
  readonly scope: Scope<"machine">;
  readonly constructors: Constructors;
  readonly entities: ReadonlyMap<string, Entity>;
  readonly locals: ReadonlyMap<string, Local>;
  /** Optional cells an enclosing `if` proved present. */
  readonly present: ReadonlySet<Slot>;
  readonly moment: Moment;
};

/**
 * Where a checked value lands, for messages: `noun` is what it fills (`steps`, `Clip.root`), `by` what writes it
 * (`this row`).
 */
export type Target = { readonly type: DataType; readonly noun: string; readonly by: string; };

export const declarationOf = (env: Env, type: DataType): TypeDecl | undefined =>
  type.kind === "named" ? env.scope.universe.get(type.key) : undefined;

const inner = (type: DataType): DataType => type.kind === "optional" ? type.inner : type;

const optional = (type: DataType): boolean => type.kind === "optional";

/** A local, then a machine entity. A constructor is not a value name; `against` resolves it by type. */
type Read = Extract<Expr, { readonly kind: "ref"; }>;

export const read = (env: Env, name: Name): Check<Read> =>
  check<Read>(function*() {
    const { span } = name;
    const local = env.locals.get(name.name);
    if (local) {
      yield* facts.reference(local, span);
      yield* facts.typed(`${name.name} : ${showType(local.type)}`, span);
      return { kind: "ref", ref: { kind: "local", local }, type: local.type, span };
    }
    const entity = env.entities.get(name.name);
    if (!entity) {
      const known = env.constructors.get(name.name);
      if (known?.length) {
        return yield* error(name, `${describe(known[0]!)}; write it where a ${known[0]!.of.name.name} goes`);
      }
      return yield* error(name, `Unknown name: ${name.name}`);
    }
    if (entity.kind === "input") {
      return yield* error(name, `${name.name} is an input, not a value`);
    }
    if (env.moment === "initial") {
      return yield* error(name, `An initial value is fixed before any tick, so it cannot read ${name.name}`);
    }
    if (env.moment === "property" && entity.kind === "signal") {
      return yield* error(name, `${name.name} is a signal, which is not state; a property reads cells`);
    }
    const type = env.present.has(entity) ? inner(entity.type) : entity.type;
    yield* facts.reference(entity, span);
    yield* facts.typed(`${name.name} : ${showType(type)}`, span);
    return { kind: "ref", ref: { kind: "slot", slot: entity }, type, span };
  });

const field = (env: Env, record: Expr, name: Name): Check<Expr> =>
  check<Expr>(function*() {
    if (optional(record.type)) return yield* error(name, `${absent(record)}, so it has no ${name.name}`);
    const declaration = declarationOf(env, record.type);
    const found = declaration?.kind === "record"
      ? declaration.fields.find((f) => f.name.name === name.name)
      : undefined;
    if (!found) return yield* error(name, `${showType(record.type)} has no field ${name.name}`);
    yield* facts.reference(found, name.span);
    yield* facts.typed(`${name.name} : ${showType(found.type)}`, name.span);
    return {
      kind: "field",
      record,
      field: found,
      type: found.type,
      span: { start: record.span.start, end: name.span.end },
    };
  });

const path = (env: Env, written: G.ExprPath): Check<Expr> =>
  check(function*() {
    let value: Expr = yield* read(env, written.head);
    for (const name of written.fields) value = yield* field(env, value, name);
    return value;
  });

const subject = (expr: Expr): string => {
  if (expr.kind === "ref") return expr.ref.kind === "local" ? expr.ref.local.name.name : expr.ref.slot.name.name;
  return expr.kind === "field" ? `${subject(expr.record)}.${expr.field.name.name}` : "this";
};

const absent = (expr: Expr): string => `${subject(expr)} may be absent here`;

/** The constructor `name` means where `type` is expected, or why it cannot be one. */
const construct = (env: Env, name: Name, type: DataType): Check<Constructor> =>
  check(function*() {
    const known = env.constructors.get(name.name) ?? [];
    const declaration = declarationOf(env, inner(type));
    const found = known.find(({ of }) => of === declaration) ?? known[0];
    if (!found) return yield* error(name, `Unknown constructor: ${name.name}`);
    if (found.of !== declaration) return yield* error(name, `${describe(found)}, not ${showType(type)}`);
    const id = found.kind === "member" ? found.member : found.variant;
    yield* facts.reference(id, name.span);
    yield* facts.typed(found.kind === "member" ? found.of.name.name : `${found.of.name.name}.${name.name}`, name.span);
    return found;
  });

const arity = (variant: Variant, given: number): string => {
  const fields = variant.fields.length;
  return `${variant.name.name} takes ${fields} argument${fields === 1 ? "" : "s"}, but this gives ${given}`;
};

const named = (of: TypeDecl): DataType => ({ kind: "named", key: of.key, name: of.name.name });

const call = (env: Env, written: G.ExprCall, target: Target): Check<Expr> =>
  check<Expr>(function*() {
    const found = yield* construct(env, written.callee, target.type);
    if (found.kind === "member") return yield* error(written.callee, `${describe(found)}; it takes no arguments`);
    const { variant, of } = found;
    if (variant.fields.length !== written.args.length) {
      return yield* error(written, arity(variant, written.args.length));
    }
    const args: Expr[] = [];
    for (const [index, arg] of written.args.entries()) {
      const { name, type } = variant.fields[index]!;
      args.push(yield* against(env, arg, { type, noun: `${variant.name.name}.${name.name}`, by: target.by }));
    }
    return { kind: "variant", of, variant, args, type: named(of), span: written.span };
  });

const bare = (env: Env, name: Name, target: Target, span: G.ExprPath["span"]): Check<Expr> =>
  check<Expr>(function*() {
    const found = yield* construct(env, name, target.type);
    if (found.kind === "member") {
      return { kind: "member", of: found.of, member: found.member, type: named(found.of), span };
    }
    if (found.variant.fields.length) {
      return yield* error(name, arity(found.variant, 0));
    }
    return { kind: "variant", of: found.of, variant: found.variant, args: [], type: named(found.of), span };
  });

const record = (env: Env, written: G.ExprRecord, target: Target): Check<Expr> =>
  check<Expr>(function*() {
    const declaration = declarationOf(env, inner(target.type));
    if (declaration?.kind !== "record") {
      return yield* error(written, `${target.noun} is ${showType(target.type)}, but this is a record`);
    }
    const given = new Map<Field, Expr | undefined>();
    for (const { name, value } of written.fields) {
      yield* attempt(check(function*() {
        const found = declaration.fields.find((f) => f.name.name === name.name);
        if (!found) return yield* error(name, `${declaration.name.name} has no field ${name.name}`);
        if (given.has(found)) return yield* error(name, `Duplicate field: ${declaration.name.name}.${name.name}`);
        const noun = `${declaration.name.name}.${name.name}`;
        const expr = value ?? { kind: "path", head: name, fields: [], span: name.span };
        if (value) {
          yield* facts.reference(found, name.span);
          yield* facts.typed(`${name.name} : ${showType(found.type)}`, name.span);
        }
        given.set(found, undefined);
        given.set(found, yield* against(env, expr, { type: found.type, noun, by: target.by }));
      }));
    }
    const missing = declaration.fields.filter((f) => !given.has(f) && !optional(f.type));
    for (const { name, type } of missing) {
      yield* attempt(error(written, `${declaration.name.name} needs ${name.name} : ${showType(type)}`));
    }
    const fields = declaration.fields.map((f) => [f, given.get(f)] as const);
    return { kind: "record", of: declaration, fields, type: named(declaration), span: written.span };
  });

const list = (env: Env, written: G.ExprList, target: Target): Check<Expr> =>
  check<Expr>(function*() {
    const type = inner(target.type);
    if (type.kind !== "list") {
      return yield* error(written, `${target.noun} is ${showType(target.type)}, but this is a list`);
    }
    const { element } = type;
    const items: { readonly spread: boolean; readonly value: Expr; }[] = [];
    let max = 0;
    for (const item of written.items) {
      const spread = item.kind === "spread";
      const value = yield* against(
        env,
        item.value,
        spread
          ? { type: { kind: "list", element, max: Infinity }, noun: `a spread into ${target.noun}`, by: target.by }
          : { type: element, noun: `an element of ${target.noun}`, by: target.by },
      );
      max += spread && value.type.kind === "list" ? value.type.max : 1;
      items.push({ spread, value });
    }
    return { kind: "list", items, type: { kind: "list", element, max }, span: written.span };
  });

/**
 * Why `expr` cannot fill `target`, worded for the user: absent where present is needed, a list longer
 * than the bound, or a plain type mismatch.
 */
const misfit = (expr: Expr, target: Target): string | undefined => {
  const [from, to] = [expr.type, target.type];
  if (assignable(from, to)) return undefined;
  if (optional(from) && assignable(inner(from), to)) return `${absent(expr)}; only a signal's if makes it present`;
  const [a, b] = [inner(from), inner(to)];
  if (a.kind === "list" && b.kind === "list" && assignable({ ...a, max: b.max }, b)) {
    const holds = a.max === Infinity ? "any number" : String(a.max);
    return `${target.noun} holds at most ${b.max}, but ${target.by} can make it hold ${holds}`;
  }
  return `${target.noun} is ${showType(to)}, but this is ${showType(from)}`;
};

export const fits = (expr: Expr, target: Target): Check<Expr> =>
  check(function*() {
    const reason = misfit(expr, target);
    if (reason) return yield* error(expr, reason);
    return expr;
  });

/** Checks `written` where a value of `target.type` is expected, so a constructor resolves by that type. */
export const against = (env: Env, written: G.Expr, target: Target): Check<Expr> =>
  check(function*() {
    switch (written.kind) {
      case "path": {
        const { head, fields } = written;
        const constructor = !env.locals.has(head.name) && !env.entities.has(head.name)
          && env.constructors.has(head.name);
        if (constructor && !fields.length) return yield* fits(yield* bare(env, head, target, written.span), target);
        return yield* fits(yield* path(env, written), target);
      }
      case "call":
        return yield* fits(yield* call(env, written, target), target);
      case "record":
        return yield* fits(yield* record(env, written, target), target);
      case "list":
        return yield* fits(yield* list(env, written, target), target);
    }
  });

/** The type of a tested subject comes from what it names, so only a name or a field path can be one. */
export const infer = (env: Env, written: G.Expr): Check<Expr> =>
  written.kind === "path" ? path(env, written) : error(written, "Test a cell, a binding or one of their fields");

/** Only `_` or a name matches a value that may be absent: there is no pattern for absence yet. */
const present = (written: G.Pattern, type: DataType): Check<void> =>
  optional(type)
    ? error(written, `This matches a ${showType(type)}, which may be absent; only _ or a name can`)
    : check(function*() {});

const comparable = (name: Name, from: DataType, type: DataType): Check<void> =>
  assignable(from, type) || assignable(type, from)
    ? check(function*() {})
    : error(name, `${name.name} is ${showType(from)}, so it never equals a ${showType(type)}`);

/** What a pattern matched against: the value's type, and for a list, the lengths it can still have. */
type Matching = { readonly type: DataType; readonly lengths: Lengths | undefined; };

/**
 * Checks one pattern, binding fresh names into `bound` left to right, so a name bound earlier in the same
 * pattern is an equality test, as is any local, cell or signal already in scope.
 */
const pattern = (env: Env, bound: Map<string, Local>, written: G.Pattern, matching: Matching): Check<Pattern> =>
  check<Pattern>(function*() {
    const { type } = matching;
    const { span } = written;
    if (written.kind === "wild") return { kind: "wild", type, span };
    if (written.kind !== "name" || written.args) yield* present(written, type);
    switch (written.kind) {
      case "name": {
        const { name, args } = written;
        if (args) return yield* variant(env, bound, written, args, type);
        if (bound.has(name.name) || env.locals.has(name.name) || env.entities.has(name.name)) {
          const value = yield* read({ ...env, locals: new Map([...env.locals, ...bound]) }, name);
          yield* comparable(name, value.type, type);
          return { kind: "equal", ref: value.ref, type, span };
        }
        if (env.constructors.has(name.name)) {
          yield* present(written, type);
          const found = yield* construct(env, name, type);
          return found.kind === "member"
            ? { kind: "member", of: found.of, member: found.member, type, span }
            : { kind: "variant", of: found.of, variant: found.variant, args: undefined, type, span };
        }
        return { kind: "bind", local: yield* fresh(bound, name, type), type, span };
      }
      case "record": {
        const declaration = declarationOf(env, type);
        if (declaration?.kind !== "record") {
          return yield* error(written, `A record pattern matches a record, not ${showType(type)}`);
        }
        const fields: (readonly [Field, Pattern])[] = [];
        for (const { name, pattern: nested } of written.fields) {
          const found = declaration.fields.find((f) => f.name.name === name.name);
          if (!found) return yield* error(name, `${declaration.name.name} has no field ${name.name}`);
          if (fields.some(([f]) => f === found)) {
            return yield* error(name, `Duplicate field: ${declaration.name.name}.${name.name}`);
          }
          yield* facts.reference(found, name.span);
          yield* facts.typed(`${name.name} : ${showType(found.type)}`, name.span);
          fields.push([found, yield* pattern(env, bound, nested, { type: found.type, lengths: undefined })]);
        }
        return { kind: "record", of: declaration, fields, type, span };
      }
      case "list":
        return yield* items(env, bound, written, matching);
    }
  });

const fresh = (bound: Map<string, Local>, name: Name, type: DataType): Check<Local> =>
  check(function*() {
    const local: Local = { id: Symbol(name.name), name, type };
    bound.set(name.name, local);
    yield* facts.define({ id: local.id, name: name.name, type: `${name.name} : ${showType(type)}` }, name.span);
    return local;
  });

const variant = (
  env: Env,
  bound: Map<string, Local>,
  written: G.PatternName,
  args: G.Args,
  type: DataType,
): Check<Pattern> =>
  check<Pattern>(function*() {
    const found = yield* construct(env, written.name, type);
    if (found.kind === "member") return yield* error(written.name, `${describe(found)}; it takes no arguments`);
    const { fields } = found.variant;
    if (fields.length !== args.items.length) return yield* error(args, arity(found.variant, args.items.length));
    const matched: Pattern[] = [];
    for (const [index, arg] of args.items.entries()) {
      matched.push(yield* pattern(env, bound, arg, { type: fields[index]!.type, lengths: undefined }));
    }
    return { kind: "variant", of: found.of, variant: found.variant, args: matched, type, span: written.span };
  });

/** `[a, b, _]` matches exactly three; `[..s, Loop(c)]` at least one, binding `s` to what is left. */
const items = (env: Env, bound: Map<string, Local>, written: G.PatternList, matching: Matching): Check<Pattern> =>
  check<Pattern>(function*() {
    const { type } = matching;
    const { span } = written;
    if (type.kind !== "list") return yield* error(written, `A list pattern matches a list, not ${showType(type)}`);
    const spreads = written.items.filter((item) => item.kind === "spread");
    if (spreads.length > 1) return yield* error(spreads[1]!, "A list pattern spreads at most once");
    const element = { type: type.element, lengths: undefined };
    const each = (list: readonly G.PatternItem[]) =>
      check(function*() {
        const matched: Pattern[] = [];
        for (const item of list) {
          if (item.kind === "one") matched.push(yield* pattern(env, bound, item.pattern, element));
        }
        return matched;
      });
    const [spread] = spreads;
    if (!spread) return { kind: "tuple", items: yield* each(written.items), type, span };
    const at = written.items.indexOf(spread);
    const head = yield* each(written.items.slice(0, at));
    const tail = yield* each(written.items.slice(at + 1));
    if (spread.rest.kind === "wild") return { kind: "spread", head, rest: undefined, tail, type, span };
    const { name } = spread.rest;
    if (bound.has(name.name) || env.locals.has(name.name) || env.entities.has(name.name)) {
      return yield* error(name, `${name.name} is already bound; a spread binds a fresh name`);
    }
    if (env.constructors.has(name.name)) {
      return yield* error(name, `${describe(env.constructors.get(name.name)![0]!)}; a spread binds a fresh name`);
    }
    const fixed = head.length + tail.length;
    const seen = intersect(matching.lengths ?? upTo(type.max), atLeast(fixed));
    const max = longest(rest(seen, fixed)) ?? type.max;
    const local = yield* fresh(bound, name, { kind: "list", element: type.element, max });
    return { kind: "spread", head, rest: local, tail, type, span };
  });

export type Matched = { readonly pattern: Pattern; readonly bound: ReadonlyMap<string, Local>; };

/**
 * Checks a pattern against the value it matches. `lengths` is what the rows above left of a list value, which
 * narrows a spread's rest: under `[a, b, _]`, `[..s]` binds `s : [Step; ..2]`.
 */
export const match = (env: Env, written: G.Pattern, type: DataType, lengths?: Lengths): Check<Matched> =>
  check(function*() {
    const bound = new Map<string, Local>();
    return { pattern: yield* pattern(env, bound, written, { type, lengths }), bound };
  });

/** Matches every value of its type that has a length it admits. Row narrowing rests on this. */
export const irrefutable = (pattern: Pattern): boolean => {
  switch (pattern.kind) {
    case "wild":
    case "bind":
      return true;
    case "equal":
      return false;
    case "member":
      return pattern.of.members.length === 1;
    case "variant":
      return pattern.of.variants.length === 1 && (pattern.args ?? []).every(irrefutable);
    case "record":
      return pattern.fields.every(([, nested]) => irrefutable(nested));
    case "tuple":
      return pattern.items.every(irrefutable);
    case "spread":
      return [...pattern.head, ...pattern.tail].every(irrefutable);
  }
};

/** The list lengths a pattern can match. */
export const admits = (pattern: Pattern): Lengths => {
  switch (pattern.kind) {
    case "tuple":
      return exactly(pattern.items.length);
    case "spread":
      return atLeast(pattern.head.length + pattern.tail.length);
    default:
      return atLeast(0);
  }
};

/**
 * `steps contains SlowStrum({ feel = Half })`, `c.feel is Half`. Names a test's pattern binds are scoped to that
 * one test, so nothing leaks into a row's value.
 */
export const formula = (env: Env, written: G.Formula): Check<Formula> =>
  check<Formula>(function*() {
    const { span } = written;
    switch (written.kind) {
      case "group":
        return yield* formula(env, written.inner);
      case "prefix":
        return { kind: "not", operand: yield* formula(env, written.operand), span };
      case "binary": {
        const left = yield* formula(env, written.left);
        const right = yield* formula(env, written.right);
        return { kind: written.operator, left, right, span };
      }
      case "test": {
        const tested = yield* infer(env, written.subject);
        const { test } = written;
        if (optional(tested.type)) {
          return yield* error(tested, `${absent(tested)}, and ${test} cannot test an absent value yet`);
        }
        if (test === "is") {
          const { pattern } = yield* match(env, written.pattern, tested.type);
          return { kind: test, subject: tested, pattern, span };
        }
        if (tested.type.kind !== "list") {
          return yield* error(tested, `contains tests a list, but ${subject(tested)} is ${showType(tested.type)}`);
        }
        const { pattern } = yield* match(env, written.pattern, tested.type.element);
        return { kind: test, subject: tested, pattern, span };
      }
    }
  });
