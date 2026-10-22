import { type Diagnostic, type RelatedDiagnostic, render, type SourceLocation } from "langkit";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { showFormula, showSync, type System } from "./domain-model.ts";
import type { Finding, Outcome, Step } from "./explore.ts";
import { type Code, digit, type Product } from "./product.ts";

/**
 * The CLI's limit in reachable states: under the 2^24 entries a JS Map holds, and at about 370MB per million
 * states (tools/domain-bench.ts) inside a default heap, so a huge system stops with an error instead of a crash.
 */
export const checkLimit = 5_000_000;

const at = (location: SourceLocation, message: string): Diagnostic => ({
  message,
  context: [],
  span: location.span,
  origin: location,
  location,
});

const states = (system: System, product: Product, code: Code): string =>
  system.components.map(({ id, name, machine }) =>
    `${name.name} ${machine.states[digit(product, code, id)]!.name.name}`
  )
    .join(", ");

/**
 * One row per step, at the clause that fired it, wherever that clause lives. A local step points at the
 * `|> on` clause its component took; a sync step points at the `|> sync` clause and spells out every port.
 */
const row = (system: System, product: Product, step: Step, number: number): RelatedDiagnostic => {
  const { origin } = product.actions[step.action]!;
  const moved = (component: System["components"][number]) => {
    const from = component.machine.states[digit(product, step.from, component.id)]!;
    const to = component.machine.states[digit(product, step.to, component.id)]!;
    return { from, text: `${component.name.name} ${from.name.name} -> ${to.name.name}` };
  };
  if (origin.kind === "sync") {
    const sync = system.syncs[origin.sync]!;
    return {
      location: { uri: system.uri, span: sync.span },
      message: `${number}. sync ${sync.name.name}: ${
        sync.ports.map(({ component }) => moved(component).text).join(", ")
      }`,
    };
  }
  const component = system.components[origin.component]!;
  const event = component.machine.events[origin.event]!;
  const { from, text } = moved(component);
  const clause = from.on.find((transition) => transition.event === event)!.clause;
  return {
    location: { uri: component.machine.uri, span: clause.span },
    message: `${number}. ${text} on ${event.name.name}`,
  };
};

const run = (system: System, product: Product, steps: readonly Step[], first = 1): readonly RelatedDiagnostic[] =>
  steps.map((step, index) => row(system, product, step, first + index));

const start = (system: System, product: Product): RelatedDiagnostic => ({
  location: { uri: system.uri, span: system.parts },
  message: `0. start: ${states(system, product, product.initial)}`,
});

/** `order could ship or cancel, warehouse could dispatch or release`: what the unfair components could still do. */
const idle = (system: System, product: Product, code: Code): string => {
  const could = new Map<string, string[]>();
  for (const { origin, moves } of product.actions) {
    if (moves.some(({ component, next }) => next[digit(product, code, component)]! < 0)) continue;
    const ports = origin.kind === "sync"
      ? system.syncs[origin.sync]!.ports
      : [{
        component: system.components[origin.component]!,
        event: system.components[origin.component]!.machine.events[origin.event]!,
      }];
    for (const { component, event } of ports) {
      could.set(component.name.name, [...(could.get(component.name.name) ?? []), event.name.name]);
    }
  }
  if (!could.size) return "nothing can happen";
  const parts = [...could].map(([component, events]) => `${component} could ${events.join(" or ")}`);
  return `${parts.join(", ")}, and ${parts.length === 1 ? "it is not" : "none is"} fair`;
};

/**
 * A finding as one Diagnostic, built as data rather than through `Check`, which cannot attach `related`. The
 * primary location is in the system's file; `related` walks the run from its start.
 */
export const diagnose = (system: System, product: Product, finding: Finding, explored: number): Diagnostic => {
  if (finding.kind === "dead sync") {
    const sync = system.syncs[finding.sync]!;
    return at({ uri: system.uri, span: sync.span }, `Dead sync: no reachable state enables ${showSync(sync)}`);
  }
  const property = system.properties[finding.property]!;
  const location = { uri: system.uri, span: property.name.span };
  const { claim } = property;
  switch (finding.kind) {
    case "reaches": {
      const formula = claim.kind === "leadsTo" ? claim.from : claim.formula;
      const steps = finding.steps.length;
      return {
        ...at(
          location,
          `${property.name.name} fails in ${steps} step${steps === 1 ? "" : "s"}: ${showFormula(formula)}`,
        ),
        related: [start(system, product), ...run(system, product, finding.steps)],
      };
    }
    case "unreachable": {
      const formula = claim.kind === "leadsTo" ? claim.from : claim.formula;
      return at(
        location,
        `${property.name.name} fails: no reachable state has ${showFormula(formula)} (${explored} states explored)`,
      );
    }
    case "unsettled": {
      if (claim.kind !== "leadsTo") throw new Error("An unsettled finding needs a leads-to property");
      const { steps, trigger, ending } = finding;
      const last = steps.at(-1)?.to ?? product.initial;
      const name = { uri: system.uri, span: system.name.span };
      const tail: readonly RelatedDiagnostic[] = ending.kind === "stays"
        ? [{ location: name, message: `then nothing happens forever: ${idle(system, product, last)}` }]
        : [
          ...run(system, product, ending.cycle, steps.length + 1),
          {
            location: name,
            message: `then steps ${steps.length + 1} to ${steps.length + ending.cycle.length} repeat forever`,
          },
        ];
      return {
        ...at(
          location,
          `${property.name.name} fails: ${showFormula(claim.from)} after ${trigger} step${
            trigger === 1 ? "" : "s"
          }, and a fair run never reaches ${showFormula(claim.to)}`,
        ),
        related: [start(system, product), ...run(system, product, steps), ...tail],
      };
    }
  }
};

export const tooLarge = (system: System, limit: number): Diagnostic =>
  at(
    { uri: system.uri, span: system.name.span },
    `${system.name.name} is too large to check: more than ${limit} reachable states${
      limit < checkLimit ? "; pnpm domain checks it with a larger limit" : ""
    }`,
  );

export const fails = (findings: readonly Finding[], property: number): boolean =>
  findings.some((finding) => finding.kind !== "dead sync" && finding.property === property);

/** Hover on a property name: `holds in 23 states`, or where its failure is. */
export const verdict = (outcome: Outcome, property: number): string => {
  if (outcome.kind === "too large") return `not checked: more than ${outcome.limit} reachable states`;
  return fails(outcome.findings, property) ? "fails: see the error on this name" : `holds in ${outcome.states} states`;
};

const position = (source: string, offset: number) => {
  const before = source.slice(0, offset).split("\n");
  return `${before.length}:${before.at(-1)!.length + 1}`;
};

/** The CLI form: the path and `render`'s lines for the primary, then `  path:line:col  message` per related row. */
export const renderTrace = (
  diagnostic: Diagnostic,
  read: (uri: string) => string | undefined,
  fallback: string,
): string => {
  const path = (uri: string) => relative(process.cwd(), fileURLToPath(uri));
  const location = diagnostic.location ?? diagnostic.origin;
  const uri = location?.uri ?? fallback;
  const primary = `${path(uri)} ${render(location ? { ...diagnostic, span: location.span } : diagnostic, read(uri))}`;
  const rows = (diagnostic.related ?? []).map(({ location, message }) => {
    const source = read(location.uri);
    return [`${path(location.uri)}${source === undefined ? "" : `:${position(source, location.span.start)}`}`, message];
  });
  const width = Math.max(0, ...rows.map(([where]) => where!.length));
  return [primary, ...rows.map(([where, message]) => `  ${where!.padEnd(width)}  ${message}`)].join("\n");
};
