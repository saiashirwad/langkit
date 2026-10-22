import { type Check, check } from "langkit";
import {
  type Claim,
  type Component,
  componentId,
  type Field,
  type Formula,
  type Port,
  type Property,
  same,
  showClaim,
  showEvent,
  showType,
  type StateId,
  type Sync,
  type System,
} from "./domain-model.ts";
import type { ClaimExpr, Declaration, FormulaExpr, Name, Port as Written, SystemClause } from "./domain-syntax.ts";
import { attempt, type Binder, error, facts, reserved, type Scope } from "./scope.ts";
import { article } from "./types.ts";

export type SystemDeclaration = Extract<Declaration, { readonly kind: "system"; }>;

type Clause<K extends SystemClause["kind"]> = Extract<SystemClause, { readonly kind: K; }>;

type Components = ReadonlyMap<string, Component>;

const component = (components: Components, name: Name): Check<Component> =>
  check(function*() {
    const found = components.get(name.name);
    if (!found) return yield* error(name, `Unknown component: ${name.name}`);
    yield* facts.reference({ id: found.symbol }, name.span);
    return found;
  });

const port = (components: Components, written: Written): Check<Port> =>
  check(function*() {
    const owner = yield* component(components, written.component);
    const event = owner.machine.events.find(({ name }) => name.name === written.event.name);
    if (!event) return yield* error(written.event, `${owner.machine.name.name} has no event ${written.event.name}`);
    yield* facts.reference(event, written.event.span);
    yield* facts.typed(showEvent(event), written.event.span);
    return { component: owner, event, span: written.span };
  });

const label = ({ component, event }: Port): string => `${component.name.name}.${event.name.name}`;

/**
 * `sync order.checkout = payment.authorize`: ports, then the payload merged by name. Each event is in at most one
 * sync, and a name two ports share must have one type, so one value can feed both.
 */
const sync = (components: Components, clause: Clause<"sync">, synced: Map<symbol, Port>): Check<Sync> =>
  check(function*() {
    const ports: Port[] = [];
    for (const written of clause.ports) {
      const resolved = yield* port(components, written);
      if (ports.some((seen) => seen.component === resolved.component)) {
        return yield* error(written, `A sync joins distinct components; ${resolved.component.name.name} is here twice`);
      }
      if (synced.has(resolved.event.id)) return yield* error(written, `${label(resolved)} is already synced`);
      ports.push(resolved);
    }
    const payload: Field[] = [];
    const givers = new Map<string, Port>();
    for (const current of ports) {
      for (const field of current.event.payload) {
        const earlier = payload.find(({ name }) => name.name === field.name.name);
        if (!earlier) {
          payload.push(field);
          givers.set(field.name.name, current);
        } else if (!same(earlier.type, field.type)) {
          return yield* error(
            current,
            `${label(givers.get(field.name.name)!)} takes ${field.name.name} : ${showType(earlier.type)}, but ${
              label(current)
            } takes ${field.name.name} : ${showType(field.type)}`,
          );
        }
      }
    }
    for (const current of ports) synced.set(current.event.id, current);
    const [first, second, ...rest] = ports;
    const name = clause.ports[0].event;
    return { id: Symbol(name.name), span: clause.span, name, ports: [first!, second!, ...rest], payload };
  });

const elaborateFormula = (components: Components, formula: FormulaExpr): Check<Formula> =>
  check<Formula>(function*() {
    switch (formula.kind) {
      case "is": {
        const owner = yield* component(components, formula.component);
        const states: StateId[] = [];
        for (const written of formula.states) {
          const state = owner.machine.states.find(({ name }) => name.name === written.name);
          if (!state) return yield* error(written, `${owner.machine.name.name} has no state ${written.name}`);
          if (states.includes(state.id)) return yield* error(written, `Duplicate state: ${written.name}`);
          yield* facts.reference({ id: state.symbol }, written.span);
          states.push(state.id);
        }
        const [first, ...rest] = states;
        return {
          kind: "is",
          component: owner,
          negated: formula.negated,
          states: [first!, ...rest],
          span: formula.span,
        };
      }
      case "and":
      case "or":
        return {
          kind: formula.kind,
          left: yield* elaborateFormula(components, formula.left),
          right: yield* elaborateFormula(components, formula.right),
          span: formula.span,
        };
    }
  });

const claim = (components: Components, written: ClaimExpr): Check<Claim> =>
  check<Claim>(function*() {
    switch (written.kind) {
      case "never":
      case "possible":
        return { kind: written.kind, formula: yield* elaborateFormula(components, written.formula) };
      case "leadsTo":
        return {
          kind: "leadsTo",
          from: yield* elaborateFormula(components, written.from),
          to: yield* elaborateFormula(components, written.to),
        };
    }
  });

/**
 * The structural rules of a system, the ones the host also enforces. Nothing here depends on which states are
 * reachable; exploration is the checker's. Undefined when a component failed, whose errors are already reported.
 */
export const elaborateSystem = (
  scope: Scope,
  declaration: SystemDeclaration,
  binder: Binder,
): Check<System | undefined> =>
  check(function*() {
    const components = new Map<string, Component>();
    let complete = true;
    for (const part of declaration.components) {
      const added = yield* attempt(check(function*() {
        const target = scope.top.get(part.machine.name);
        if (!target) return yield* error(part.machine, `Unknown machine: ${part.machine.name}`);
        if (target.kind !== "machine") {
          return yield* error(part.machine, `${part.machine.name} is ${article(target.kind)}, not a machine`);
        }
        yield* facts.reference(target, part.machine.span);
        // `Shop.Parts` is the namespace's own interface, so a machine of that name would print as it.
        if (target.name.name === "Parts") {
          return yield* error(part.machine, "TypeScript cannot represent Parts, a machine in a system");
        }
        const machine = scope.machines.get(target.key);
        if (!machine) return false;
        const { name } = part;
        if (reserved.field.has(name.name)) {
          return yield* error(name, `TypeScript cannot represent ${name.name}, a component name`);
        }
        if (components.has(name.name)) return yield* error(name, `Duplicate component: ${name.name}`);
        const value: Component = { id: componentId(components.size), symbol: Symbol(name.name), name, machine };
        yield* facts.define(
          { id: value.symbol, name: name.name, type: `${name.name} : ${machine.name.name}` },
          name.span,
          "property",
        );
        components.set(name.name, value);
        return true;
      }));
      complete &&= added === true;
    }
    // A component that failed would make every clause naming it an error too.
    if (!complete) return undefined;

    const members = new Set<string>();
    const member = (name: Name): Check<void> =>
      check(function*() {
        if (reserved.event.has(name.name)) {
          yield* attempt(error(name, `TypeScript cannot represent ${name.name}, a system member`));
        }
        if (members.has(name.name)) {
          return yield* error(name, `Duplicate member: ${declaration.name.name}.${name.name}`);
        }
        members.add(name.name);
      });
    const synced = new Map<symbol, Port>();
    const syncs: Sync[] = [];
    const fair: Component[] = [];
    const properties: Property[] = [];
    for (const clause of declaration.clauses) {
      yield* attempt(check(function*() {
        switch (clause.kind) {
          case "sync": {
            const value = yield* sync(components, clause, synced);
            yield* member(value.name);
            syncs.push(value);
            return;
          }
          case "fair": {
            const value = yield* component(components, clause.component);
            if (fair.includes(value)) return yield* error(clause.component, `${value.name.name} is already fair`);
            fair.push(value);
            return;
          }
          case "property": {
            const value: Property = {
              id: Symbol(clause.name.name),
              name: clause.name,
              span: clause.span,
              claim: yield* claim(components, clause.claim),
            };
            yield* member(clause.name);
            yield* facts.define(
              {
                id: value.id,
                name: clause.name.name,
                type: `property ${clause.name.name} = ${showClaim(value.claim)}`,
              },
              clause.name.span,
              "function",
            );
            properties.push(value);
            return;
          }
        }
      }));
    }
    // Only once every sync elaborated, so a typo in one is one diagnostic, not a cascade.
    const written = declaration.clauses.filter(({ kind }) => kind === "sync").length;
    for (const { name, machine } of written === syncs.length ? components.values() : []) {
      for (const event of machine.events.filter(({ syncOnly, id }) => syncOnly && !synced.has(id))) {
        yield* attempt(error(name, `${name.name}.${event.name.name} is a sync event, but no sync fires it`));
      }
    }

    const { name } = declaration;
    yield* facts.define({ id: binder.id, name: name.name, type: `system ${name.name}` }, name.span, "namespace");
    return {
      id: binder.id,
      uri: binder.uri,
      name,
      parts: declaration.parts,
      components: [...components.values()],
      syncs,
      fair,
      properties,
    };
  });
