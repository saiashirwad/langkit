import { type Diagnostic, type Span, withDocument } from "./diagnostic.ts";

export type Result<A> =
  | { readonly success: true; readonly value: A; }
  | { readonly success: false; readonly errors: readonly [Diagnostic, ...Diagnostic[]]; };

type Reply<A> =
  | { readonly ok: true; readonly value: A; }
  | { readonly ok: false; readonly error: Diagnostic; };

export type State<T> = {
  readonly kind: "state";
  readonly init: () => T;
  readonly checkpoint: (value: T) => () => void;
};
declare const invariant: unique symbol;
export type Scoped<T> = { readonly kind: "scoped"; readonly initial: T; readonly [invariant]?: (value: T) => T; };

export const state = <T>(init: () => T, checkpoint: (value: T) => () => void): State<T> => ({
  kind: "state",
  init,
  checkpoint,
});
export const scoped = <T>(initial: T): Scoped<T> => ({ kind: "scoped", initial });

type Entry = { readonly value: unknown; readonly initialRestore: () => void; readonly checkpoint: () => () => void; };
type Storage = { readonly states: Map<State<unknown>, Entry>; readonly errors: Diagnostic[]; };
type Frame = {
  readonly values: ReadonlyMap<object, unknown>;
  readonly labels: readonly string[];
  readonly span: Span | undefined;
  readonly document: string | undefined;
};

class Runtime {
  readonly storage: Storage;
  readonly frame: Frame;

  constructor(storage: Storage, frame: Frame) {
    this.storage = storage;
    this.frame = frame;
  }

  get<T>(key: State<T> | Scoped<T>): T {
    if (key.kind === "scoped") return (this.frame.values.has(key) ? this.frame.values.get(key) : key.initial) as T;
    let entry = this.storage.states.get(key as State<unknown>);
    if (entry === undefined) {
      const value = key.init();
      entry = { value, initialRestore: key.checkpoint(value), checkpoint: () => key.checkpoint(value) };
      this.storage.states.set(key as State<unknown>, entry);
    }
    return entry.value as T;
  }

  checkpoint(): () => void {
    const previous = new Map(this.storage.states);
    const restores = [...previous.values()].map(({ checkpoint }) => checkpoint());
    return () => {
      for (const restore of restores) restore();
      for (const [key, entry] of this.storage.states) {
        if (previous.has(key)) continue;
        entry.initialRestore();
        this.storage.states.delete(key);
      }
      for (const [key, entry] of previous) this.storage.states.set(key, entry);
    };
  }

  diagnostic(message: string): Diagnostic {
    const { labels: context, span, document } = this.frame;
    const local: Diagnostic = span === undefined ? { message, context } : { message, context, span };
    return document === undefined ? local : withDocument(local, document);
  }
}

type Instruction =
  | { readonly kind: "primitive"; readonly step: (runtime: Runtime) => Reply<unknown>; }
  | { readonly kind: "bind"; readonly child: Check<unknown>; readonly next: (value: unknown) => Check<unknown>; }
  | { readonly kind: "generator"; readonly body: () => Generator<Check<unknown>, unknown, unknown>; }
  | { readonly kind: "scoped"; readonly child: Check<unknown>; readonly change: (runtime: Runtime) => Partial<Frame>; }
  | { readonly kind: "recovery"; readonly child: Check<unknown>; readonly fallback: Check<unknown>; }
  | { readonly kind: "atomic"; readonly child: Check<unknown>; };

type Continuation =
  | { readonly kind: "bind"; readonly next: (value: unknown) => Check<unknown>; }
  | { readonly kind: "generator"; readonly iterator: Generator<Check<unknown>, unknown, unknown>; }
  | { readonly kind: "scoped"; readonly outer: Runtime; }
  | { readonly kind: "recovery"; readonly fallback: Check<unknown>; }
  | { readonly kind: "atomic"; readonly restore: () => void; };

type Completion = Reply<unknown> | { readonly ok: "throw"; readonly error: unknown; };

const instructions = new WeakMap<Check<unknown>, Instruction>();
const instructed = <A>(instruction: Instruction): Check<A> => {
  const checker: Check<A> = Object.create(Check.prototype);
  instructions.set(checker, instruction);
  return checker;
};

// An explicit continuation stack keeps deeply nested checks from overflowing the call stack.
const evaluate = <A>(checker: Check<A>, initial: Runtime): Reply<A> => {
  let runtime = initial;
  let current: Check<unknown> | undefined = checker;
  let completion: Completion = { ok: true, value: undefined };
  const stack: Continuation[] = [];
  const advance = (iterator: Generator<Check<unknown>, unknown, unknown>, value?: unknown) => {
    const result = iterator.next(value);
    if (result.done) completion = { ok: true, value: result.value };
    else {
      stack.push({ kind: "generator", iterator });
      current = result.value;
    }
  };
  while (current !== undefined || stack.length > 0) {
    try {
      if (current !== undefined) {
        const instruction: Instruction = instructions.get(current)!;
        current = undefined;
        switch (instruction.kind) {
          case "primitive":
            completion = instruction.step(runtime);
            break;
          case "bind":
            stack.push({ kind: "bind", next: instruction.next });
            current = instruction.child;
            break;
          case "generator":
            advance(instruction.body());
            break;
          case "scoped":
            stack.push({ kind: "scoped", outer: runtime });
            runtime = new Runtime(runtime.storage, { ...runtime.frame, ...instruction.change(runtime) });
            current = instruction.child;
            break;
          case "recovery":
            stack.push({ kind: "recovery", fallback: instruction.fallback });
            current = instruction.child;
            break;
          case "atomic":
            stack.push({ kind: "atomic", restore: runtime.checkpoint() });
            current = instruction.child;
            break;
        }
      } else {
        const continuation = stack.pop()!;
        switch (continuation.kind) {
          case "bind":
            if (completion.ok === true) current = continuation.next(completion.value);
            break;
          case "generator":
            if (completion.ok === true) advance(continuation.iterator, completion.value);
            else if (!continuation.iterator.return(undefined).done) {
              throw new TypeError("Checks cannot be yielded during generator cleanup");
            }
            break;
          case "scoped":
            runtime = continuation.outer;
            break;
          case "recovery":
            if (completion.ok === false) {
              runtime.storage.errors.push(completion.error);
              current = continuation.fallback;
            }
            break;
          case "atomic":
            if (completion.ok !== true) continuation.restore();
            break;
        }
      }
    } catch (error) {
      current = undefined;
      completion = { ok: "throw", error };
    }
  }
  if (completion.ok === "throw") throw completion.error;
  return completion as Reply<A>;
};

export class Check<A> {
  constructor(step: (runtime: Runtime) => Reply<A>) {
    instructions.set(this, { kind: "primitive", step });
  }

  // Hand-rolled so `yield*` on a check costs one small object, not a generator.
  [Symbol.iterator](): Iterator<Check<A>, A, unknown> {
    let yielded = false;
    return {
      next: (value?: unknown) => {
        if (yielded) return { done: true, value: value as A };
        yielded = true;
        return { done: false, value: this };
      },
      return: (value?: unknown) => {
        yielded = true;
        return { done: true, value: value as A };
      },
      throw: (error?: unknown) => {
        yielded = true;
        throw error;
      },
    };
  }

  map<B>(f: (value: A) => B): Check<B> {
    return this.flatMap((value) => pure(f(value)));
  }

  flatMap<B>(f: (value: A) => Check<B>): Check<B> {
    return instructed({ kind: "bind", child: this, next: (value) => f(value as A) });
  }

  /** Records this failure as a diagnostic and continues with the fallback; `run` still fails. */
  recover<B>(fallback: Check<B>): Check<A | B>;
  recover(this: Check<void>): Check<void>;
  recover(fallback: Check<unknown> = pure(undefined)): Check<unknown> {
    return instructed({ kind: "recovery", child: this, fallback });
  }

  /** Restores every `State` this check touched when it fails or throws. */
  atomic(): Check<A> {
    return instructed({ kind: "atomic", child: this });
  }

  context(label: string): Check<A> {
    return scope(this, (runtime) => ({ labels: [...runtime.frame.labels, label] }));
  }

  at(span: Span | undefined): Check<A> {
    return span === undefined ? this : scope(this, () => ({ span }));
  }

  inDocument(uri: string): Check<A> {
    return scope(this, () => ({ document: uri }));
  }
}

const scope = <A>(child: Check<A>, change: (runtime: Runtime) => Partial<Frame>): Check<A> =>
  instructed({ kind: "scoped", child, change });

export const check = <A>(body: () => Generator<Check<unknown>, A, unknown>): Check<A> =>
  instructed({ kind: "generator", body });

export const pure = <A>(value: A): Check<A> => new Check(() => ({ ok: true, value }));
export const fail = (message: string): Check<never> =>
  new Check((runtime) => ({ ok: false, error: runtime.diagnostic(message) }));
export const get = <T>(key: State<T> | Scoped<T>): Check<T> =>
  new Check((runtime) => ({ ok: true, value: runtime.get(key) }));

export const within = <T, A>(key: Scoped<T>, update: (current: T) => T, body: Check<A>): Check<A> =>
  scope(body, (runtime) => ({ values: new Map(runtime.frame.values).set(key, update(runtime.get(key))) }));

export const bind = <T, A>(
  env: Scoped<ReadonlyMap<string, T>>,
  entries: Iterable<readonly [string, T]>,
  body: Check<A>,
): Check<A> => within(env, (current) => new Map([...current, ...entries]), body);

export const lookup = <T>(env: Scoped<ReadonlyMap<string, T>>, name: string): Check<T> =>
  get(env).flatMap((current) => current.has(name) ? pure(current.get(name) as T) : fail(`Unbound variable: ${name}`));

export const run = <A>(checker: Check<A>): Result<A> => {
  const storage: Storage = { states: new Map(), errors: [] };
  const frame: Frame = { values: new Map(), labels: [], span: undefined, document: undefined };
  const reply = evaluate(checker, new Runtime(storage, frame));
  const [first, ...rest] = storage.errors;
  if (!reply.ok) return { success: false, errors: first ? [first, ...rest, reply.error] : [reply.error] };
  return first === undefined ? { success: true, value: reply.value } : { success: false, errors: [first, ...rest] };
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
