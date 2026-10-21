import { type Check, get, state } from "./check.ts";

/** Resolve inference variables without mutating or compressing their link path. */
export const pruneLink = <T, V extends object>(
  value: T,
  variable: (value: T) => V | null,
  instance: (variable: V) => T | undefined,
): T => {
  let current = value;
  for (;;) {
    const node = variable(current);
    if (node === null) return current;
    const target = instance(node);
    if (target === undefined) return current;
    current = target;
  }
};

/** Names variables a, b, …, z, a1, … in first-seen order. */
export const variableNames = <V>(first = "a"): (variable: V) => string => {
  const names = new Map<V, string>();
  return (variable) => {
    let name = names.get(variable);
    if (name === undefined) {
      const index = names.size;
      name = String.fromCharCode(first.charCodeAt(0) + (index % 26)) + (index >= 26 ? Math.floor(index / 26) : "");
      names.set(variable, name);
    }
    return name;
  };
};

type Undo = () => void;
const undoJournal = state<Undo[]>(() => [], (entries) => {
  const length = entries.length;
  return () => {
    while (entries.length > length) entries.pop()!();
  };
});

export const assign = <T extends object, K extends keyof T>(target: T, key: K, value: T[K]): Check<void> =>
  get(undoJournal).map((journal) => {
    const existed = Object.prototype.hasOwnProperty.call(target, key);
    const previous = target[key];
    if (existed && Object.is(previous, value)) return;
    journal.push(() => {
      if (existed) target[key] = previous;
      else Reflect.deleteProperty(target, key);
    });
    target[key] = value;
  });

export const add = <T>(target: Set<T>, value: T): Check<void> =>
  get(undoJournal).map((journal) => {
    if (target.has(value)) return;
    journal.push(() => {
      target.delete(value);
    });
    target.add(value);
  });

export const push = <T>(target: T[], value: T): Check<void> =>
  get(undoJournal).map((journal) => {
    const length = target.length;
    journal.push(() => {
      target.length = length;
    });
    target.push(value);
  });
