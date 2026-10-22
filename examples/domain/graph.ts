import type { Event, Machine, State, StateId, Transition } from "./domain-model.ts";

/** States the initial state reaches: BFS over `State.on`. */
export const reachable = (machine: Machine): ReadonlySet<StateId> => {
  const seen = new Set([machine.initial]);
  const queue = [machine.initial];
  for (const id of queue) {
    for (const { to } of machine.states[id]!.on) {
      if (seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
};

/** Edges into each state, built here because only `finishing` walks backwards. */
const incoming = (machine: Machine): ReadonlyMap<StateId, readonly Transition[]> => {
  const edges = new Map<StateId, Transition[]>();
  for (const { on } of machine.states) {
    for (const transition of on) {
      const into = edges.get(transition.to) ?? [];
      into.push(transition);
      edges.set(transition.to, into);
    }
  }
  return edges;
};

/** States with a path to some final state: reverse BFS from every final state. */
export const finishing = (machine: Machine): ReadonlySet<StateId> => {
  const edges = incoming(machine);
  const queue = machine.states.filter(({ final }) => final).map(({ id }) => id);
  const seen = new Set(queue);
  for (const id of queue) {
    for (const { from } of edges.get(id) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  return seen;
};

/** Events no state handles. */
export const unhandled = (machine: Machine): readonly Event[] => {
  const handled = new Set(machine.states.flatMap(({ on }) => on.map(({ event }) => event)));
  return machine.events.filter((event) => !handled.has(event));
};

export type Finding =
  | { readonly kind: "unreachable" | "dead end" | "cannot finish"; readonly state: State; }
  | { readonly kind: "unhandled"; readonly event: Event; };

/**
 * Every structural defect, states in declaration order and then events. A machine without a final state is a
 * cycle, like a traffic light, so `cannot finish` needs a final state to aim at. A dead end is not also reported
 * as unable to finish: one defect, one finding.
 */
export const audit = (machine: Machine): readonly Finding[] => {
  const reaches = reachable(machine);
  const finishes = finishing(machine);
  const finite = machine.states.some(({ final }) => final);
  const states = machine.states.flatMap((state): readonly Finding[] => {
    const deadEnd = !state.final && state.on.length === 0;
    return [
      ...(reaches.has(state.id) ? [] : [{ kind: "unreachable" as const, state }]),
      ...(deadEnd ? [{ kind: "dead end" as const, state }] : []),
      ...(finite && !deadEnd && reaches.has(state.id) && !finishes.has(state.id)
        ? [{ kind: "cannot finish" as const, state }]
        : []),
    ];
  });
  return [...states, ...unhandled(machine).map((event) => ({ kind: "unhandled" as const, event }))];
};
