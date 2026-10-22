import { type Check, check, pure } from "langkit";
import { type DataType, type Name, type Present, same, showType, showTypeDecl } from "../data/data-model.ts";
import { article, attempt, type Binder, error, facts, resolveType, type Scope, typeNames } from "../data/data-types.ts";
import { intersect, isEmpty, minus, upTo } from "./lengths.ts";
import {
  type Cell,
  type CellSlot,
  type Group,
  type Input,
  type Local,
  type Machine,
  type Node,
  type Row,
  showInput,
  showLocal,
  showSlot,
  type Signal,
  type SignalSlot,
  type Source,
} from "./reactor-model.ts";
import { lowerType } from "./reactor-syntax.ts";
import type * as G from "./reactor.grammar";
import {
  admits,
  against,
  type Constructors,
  describe,
  type Entity,
  type Env,
  formula,
  irrefutable,
  match,
} from "./values.ts";

export type MachineDeclaration = G.DeclarationMachine;

/** Every declared type name in a written type gets its declaration as hover. */
export const hover = (scope: Scope, written: G.DataType): Check<void> =>
  check(function*() {
    for (const name of typeNames(lowerType(written))) {
      const binder = scope.top.get(name.name);
      const declaration = binder && scope.universe.get(binder.key);
      if (declaration) yield* facts.typed(showTypeDecl(declaration, scope.dialect.variants), name.span);
    }
  });

const resolve = (scope: Scope, written: G.DataType): Check<DataType> =>
  check(function*() {
    const type = yield* resolveType(scope, lowerType(written));
    yield* hover(scope, written);
    return type;
  });

const list = (names: readonly string[]): string =>
  names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** Every name an item mentions, whatever it turns out to mean. */
const mentions = (node: unknown, into = new Set<string>()): ReadonlySet<string> => {
  if (Array.isArray(node)) { for (const child of node) mentions(child, into); }
  else if (typeof node === "object" && node !== null) {
    if ("kind" in node && node.kind === "Name" && "name" in node) into.add(String(node.name));
    else for (const child of Object.values(node)) mentions(child, into);
  }
  return into;
};

/**
 * `input press : Root | Shape | Feel`. Two or more carried types must be enums with no member in common, so the
 * member a press carries says which type it is.
 */
const input = (scope: Scope, item: G.ItemInput): Check<Input> =>
  check(function*() {
    const written = item.carries ?? [];
    const carries: Present[] = [];
    for (const type of written) {
      const resolved = yield* resolve(scope, type);
      if (resolved.kind === "optional") {
        return yield* error(type, `An input always carries a value; drop the ? from ${showType(resolved)}`);
      }
      carries.push(resolved);
    }
    const owners = new Map<string, string>();
    for (const [index, type] of carries.entries()) {
      if (carries.length < 2) break;
      const at = written[index]!;
      const declaration = type.kind === "named" ? scope.universe.get(type.key) : undefined;
      if (declaration?.kind !== "enum") {
        const kind = declaration?.kind ?? type.kind;
        yield* attempt(error(at, `An input union joins enums; ${showType(type)} is ${article(kind)}`));
        continue;
      }
      if (carries.slice(0, index).some((other) => same(other, type))) {
        yield* attempt(error(at, `${item.name.name} carries ${showType(type)} twice`));
        continue;
      }
      const shared = declaration.members.find(({ name }) => owners.has(name.name));
      if (shared) {
        const { name } = shared;
        const both = `${owners.get(name.name)} and ${declaration.name.name}`;
        yield* attempt(error(at, `${name.name} is in both ${both}, so ${item.name.name} could not tell them apart`));
      }
      for (const { name } of declaration.members) owners.set(name.name, declaration.name.name);
    }
    return { kind: "input", id: Symbol(item.name.name), name: item.name, carries };
  });

/**
 * A cell's declared type. `last Root` already says the cell is `Root?`, so a different annotation is reported
 * and the cell is `Root?` anyway, which keeps every read of it from failing a second time.
 */
const cellType = (scope: Scope, item: G.ItemCell): Check<DataType> =>
  check(function*() {
    const annotated = yield* resolve(scope, item.type);
    if (item.init.kind !== "last") return annotated;
    const { type: name } = item.init;
    const of = (yield* resolve(scope, { kind: "named", name, span: name.span })) as Present;
    const expected: DataType = { kind: "optional", inner: of };
    if (!same(annotated, expected)) {
      const message = `A last ${showType(of)} cell is ${showType(expected)}, not ${showType(annotated)}`;
      yield* attempt(error(item.type, message));
    }
    return expected;
  });

const kinds = { input: "method", cell: "property", signal: "function" } as const;

/** An item with the entity it declared. */
type Declaration =
  | { readonly kind: "input"; readonly item: G.ItemInput; readonly entity: Input; }
  | { readonly kind: "cell"; readonly item: G.ItemCell; readonly entity: CellSlot; }
  | { readonly kind: "signal"; readonly item: G.ItemSignal; readonly entity: SignalSlot; };

type Declared = {
  readonly entities: ReadonlyMap<string, Entity>;
  /** A repeated name or a constructor's name declares nothing. */
  readonly declarations: readonly Declaration[];
  /** Names whose type did not resolve. An item naming one goes unchecked, so a typo is one error, not one per read. */
  readonly broken: ReadonlySet<string>;
};

/**
 * Every input, cell and signal, before any body is checked, so a row may read a cell declared below it. They
 * share one namespace, and none may take a constructor's name, which keeps pattern names unambiguous.
 */
const declare = (scope: Scope, constructors: Constructors, items: readonly G.Item[]): Check<Declared> =>
  check(function*() {
    const entities = new Map<string, Entity>();
    const declarations: Declaration[] = [];
    const broken = new Set<string>();
    for (const item of items) {
      if (item.kind === "property") continue;
      const { name } = item;
      yield* attempt(check(function*() {
        if (entities.has(name.name) || broken.has(name.name)) {
          return yield* error(name, `Duplicate declaration: ${name.name}`);
        }
        const known = constructors.get(name.name);
        if (known?.length) {
          return yield* error(name, `${describe(known[0]!)}; ${article(item.kind)} cannot take its name`);
        }
        broken.add(name.name);
        const id = Symbol(name.name);
        const declaration: Declaration = item.kind === "input"
          ? { kind: "input", item, entity: yield* input(scope, item) }
          : item.kind === "cell"
          ? { kind: "cell", item, entity: { kind: "cell", id, name, type: yield* cellType(scope, item) } }
          : { kind: "signal", item, entity: { kind: "signal", id, name, type: yield* resolve(scope, item.type) } };
        broken.delete(name.name);
        const { entity } = declaration;
        entities.set(name.name, entity);
        declarations.push(declaration);
        const hover = entity.kind === "input" ? showInput(entity) : showSlot(entity);
        yield* facts.define({ id: entity.id, name: name.name, type: hover }, name.span, kinds[entity.kind]);
      }));
    }
    return { entities, declarations, broken };
  });

/** A name an item points at, such as a signal's input or an `if` cell, rather than reads as a value. */
const entity = (env: Env, name: Name): Check<Entity> =>
  check(function*() {
    const found = env.entities.get(name.name);
    if (!found) return yield* error(name, `Unknown name: ${name.name}`);
    yield* facts.reference(found, name.span);
    yield* facts.typed(found.kind === "input" ? showInput(found) : showSlot(found), name.span);
    return found;
  });

/**
 * `cell root : Root? = last Root` keeps the latest Root its one carrying input brought, so the cell is exactly
 * `Root?`. `cell steps : [Step; ..3] = []` starts at a value fixed before any tick.
 */
const cell = (env: Env, item: G.ItemCell, slot: CellSlot): Check<Cell> =>
  check<Cell>(function*() {
    const { init } = item;
    if (init.kind === "last") {
      const of = slot.type.kind === "optional" ? slot.type.inner : slot.type;
      const inputs = [...env.entities.values()].filter((entity): entity is Input =>
        entity.kind === "input" && entity.carries.some((type) => same(type, of))
      );
      const [carrier, ...others] = inputs;
      if (!carrier) return yield* error(init.type, `No input carries ${showType(of)}`);
      if (others.length) {
        const names = list(inputs.map(({ name }) => name.name));
        return yield* error(init.type, `${names} carry ${showType(of)}; last needs exactly one input carrying it`);
      }
      return { kind: "cell", slot, init: { kind: "last", of, input: carrier } };
    }
    const groups: Group[] = [];
    for (const written of init.groups) {
      const checked = yield* attempt(group(env, slot, written));
      if (checked) groups.push(checked);
    }
    const target = { type: slot.type, noun: slot.name.name, by: "this value" };
    const value = yield* against({ ...env, moment: "initial" }, init.value, target);
    return { kind: "cell", slot, init: { kind: "value", value, groups } };
  });

/** The value a group's binder takes: the signal's, or the one type its input carries. */
const binderType = (source: Source, binder: Name): Check<DataType> => {
  if (source.kind === "signal") return pure(source.type);
  const [carried, ...others] = source.carries;
  if (!carried) return error(binder, `${source.name.name} carries nothing to bind`);
  if (others.length) {
    const union = source.carries.map(showType).join(" | ");
    return error(binder, `${source.name.name} carries ${union}; read it through a last cell`);
  }
  return pure(carried);
};

/**
 * `on clip c` and its rows, tried in order, first match wins. Each row sees only the list lengths the
 * unguarded, irrefutable rows above it left, so after `[a, b, _]` a `[..s]` row binds `s : [Step; ..2]`.
 * A row whose pattern is wrong ends the group's checking, since the rows below depend on what it takes. Groups
 * never narrow each other: each fires in a different tick.
 */
const group = (env: Env, owner: CellSlot, written: G.Group): Check<Group> =>
  check<Group>(function*() {
    const source = yield* entity(env, written.source);
    if (source.kind === "cell") {
      return yield* error(written.source, `${source.name.name} is a cell; on takes an input or a signal`);
    }
    let binder: Local | undefined;
    if (written.binder) {
      const name = written.binder;
      const known = env.constructors.get(name.name);
      if (known?.length) return yield* error(name, `${describe(known[0]!)}; a binding cannot take its name`);
      binder = { id: Symbol(name.name), name, type: yield* binderType(source, name) };
      yield* facts.define({ id: binder.id, name: name.name, type: showLocal(binder) }, name.span, "parameter");
    }
    const scoped: Env = { ...env, locals: binder ? new Map([[binder.name.name, binder]]) : new Map() };
    const { type } = owner;
    let remaining = type.kind === "list" ? upTo(type.max) : undefined;
    let exhausted = false;
    const rows: Row[] = [];
    for (const row of written.rows) {
      const matched = yield* attempt(match(scoped, row.pattern, type, remaining));
      if (!matched) break;
      const checked = yield* attempt(check<Row>(function*() {
        const { pattern, bound } = matched;
        const admitted = admits(pattern);
        if (exhausted || (remaining && isEmpty(intersect(remaining, admitted)))) {
          return yield* error(row.pattern, "This row never fires; the rows above already take every value it matches");
        }
        if (!row.guard && irrefutable(pattern)) {
          if (remaining) remaining = minus(remaining, admitted);
          else exhausted = true;
        }
        const inside: Env = { ...scoped, locals: new Map([...scoped.locals, ...bound]) };
        const guard = row.guard
          ? { sense: row.guard.sense, formula: yield* formula(inside, row.guard.formula) }
          : undefined;
        const target = { type, noun: owner.name.name, by: "this row" };
        const value = yield* against(inside, row.value, target);
        return { pattern, guard, value, span: row.span };
      }));
      if (checked) rows.push(checked);
    }
    return { source, binder, rows, span: written.span };
  });

/**
 * `signal clip : Clip = on press if root, shape, feel -> { root, shape, feel }` fires on an input, and only
 * while every listed optional cell holds a value; inside the arrow each listed cell is that value.
 */
const signal = (env: Env, item: G.ItemSignal, slot: SignalSlot): Check<Signal> =>
  check<Signal>(function*() {
    const source = yield* entity(env, item.source);
    if (source.kind !== "input") {
      return yield* error(
        item.source,
        `${slot.name.name} fires on an input; ${item.source.name} is ${article(source.kind)}`,
      );
    }
    const present: CellSlot[] = [];
    for (const name of item.present) {
      const found = yield* entity(env, name);
      if (found.kind !== "cell") {
        return yield* error(name, `${name.name} is ${article(found.kind)}; if lists optional cells`);
      }
      if (found.type.kind !== "optional") {
        return yield* error(name, `${name.name} is never absent; drop it from if`);
      }
      if (present.includes(found)) return yield* error(name, `${name.name} is listed twice`);
      present.push(found);
    }
    const narrowed: Env = { ...env, present: new Set(present) };
    const value = yield* against(narrowed, item.value, { type: slot.type, noun: slot.name.name, by: "this signal" });
    return { kind: "signal", slot, source, present, value };
  });

export const elaborateMachine = (
  scope: Scope<"machine">,
  constructors: Constructors,
  declaration: MachineDeclaration,
  binder: Binder<"machine">,
): Check<Machine> =>
  check(function*() {
    const { name } = declaration;
    yield* facts.define({ id: binder.id, name: name.name, type: `machine ${name.name}` }, name.span, "namespace");
    const { entities, declarations, broken } = yield* declare(scope, constructors, declaration.items);
    const env: Env = { scope, constructors, entities, locals: new Map(), present: new Set(), moment: "tick" };
    const inputs: Input[] = [];
    const nodes: Node[] = [];
    const unknownCarriers = declaration.items.some((item) => item.kind === "input" && broken.has(item.name.name));
    for (const declared of declarations) {
      if ([...mentions(declared.item)].some((name) => broken.has(name))) continue;
      if (unknownCarriers && declared.item.kind === "cell" && declared.item.init.kind === "last") continue;
      if (declared.kind === "input") {
        inputs.push(declared.entity);
        continue;
      }
      const node = declared.kind === "cell"
        ? yield* attempt(cell(env, declared.item, declared.entity))
        : yield* attempt(signal(env, declared.item, declared.entity));
      if (node) nodes.push(node);
    }
    return { id: binder.id, uri: binder.uri, name, inputs, nodes, properties: [] };
  });
