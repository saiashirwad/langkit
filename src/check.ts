import { withDocument, type Diagnostic, type Span } from "./diagnostic.ts";

export type Result<A> =
  | { readonly success: true; readonly value: A }
  | { readonly success: false; readonly errors: readonly [Diagnostic, ...Diagnostic[]] };

type Reply<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: Diagnostic };

const invariant = Symbol();

type Checkpointable<T> = {
  readonly kind: "state";
  readonly init: () => T;
  readonly checkpoint: (value: T) => () => void;
};

export type State<T> = Checkpointable<T>;
export type Scoped<T> = { readonly kind: "scoped"; readonly initial: T; readonly [invariant]: (value: T) => T };

export const state = <T>(init: () => T, checkpoint: (value: T) => () => void): State<T> => ({ kind: "state", init, checkpoint });
export const scoped = <T>(initial: T): Scoped<T> => ({ kind: "scoped", initial, [invariant]: (value) => value });

type Entry = { readonly value: unknown; readonly initialRestore: () => void; readonly checkpoint: () => () => void };
type Storage = { readonly states: Map<State<unknown>, Entry>; readonly errors: Diagnostic[] };
type RuntimeInit = {
  readonly storage: Storage;
  readonly values: ReadonlyMap<object, unknown>;
  readonly labels: readonly string[];
  readonly span: Span | undefined;
  readonly document: string | undefined;
};

class Runtime {
  readonly storage: Storage;
  readonly values: ReadonlyMap<object, unknown>;
  readonly labels: readonly string[];
  readonly span: Span | undefined;
  readonly document: string | undefined;

  constructor(init: Partial<RuntimeInit> = {}) {
    this.storage = init.storage ?? { states: new Map(), errors: [] };
    this.values = init.values ?? new Map();
    this.labels = init.labels ?? [];
    this.span = init.span;
    this.document = init.document;
  }

  derive(changes: Partial<Omit<RuntimeInit, "storage">>): Runtime {
    return new Runtime({ storage: this.storage, values: this.values, labels: this.labels, span: this.span, document: this.document, ...changes });
  }

  get<T>(key: State<T> | Scoped<T>): T {
    if (key.kind === "scoped") return (this.values.has(key) ? this.values.get(key) : key.initial) as T;
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
    const local: Diagnostic = this.span === undefined ? { message, context: this.labels } : { message, context: this.labels, span: this.span };
    return this.document === undefined ? local : withDocument(local, this.document);
  }
}

export class Check<A> {
  readonly step: (runtime: Runtime) => Reply<A>;

  constructor(step: (runtime: Runtime) => Reply<A>) { this.step = step; }
  *[Symbol.iterator](): Generator<Check<A>, A, unknown> { return (yield this) as A; }

  map<B>(f: (value: A) => B): Check<B> {
    return new Check((runtime) => {
      const reply = this.step(runtime);
      return reply.ok ? { ok: true, value: f(reply.value) } : reply;
    });
  }

  flatMap<B>(f: (value: A) => Check<B>): Check<B> {
    return new Check((runtime) => {
      const reply = this.step(runtime);
      return reply.ok ? f(reply.value).step(runtime) : reply;
    });
  }

  recover<B>(fallback: Check<B>): Check<A | B>;
  recover(this: Check<void>): Check<void>;
  recover(fallback: Check<unknown> = pure(undefined)): Check<unknown> {
    return new Check((runtime) => {
      const reply = this.step(runtime);
      if (reply.ok) return reply;
      runtime.storage.errors.push(reply.error);
      return fallback.step(runtime);
    });
  }

  atomic(): Check<A> {
    return new Check((runtime) => {
      const restore = runtime.checkpoint();
      try {
        const reply = this.step(runtime);
        if (!reply.ok) restore();
        return reply;
      } catch (error) {
        restore();
        throw error;
      }
    });
  }

  context(label: string): Check<A> {
    return new Check((runtime) => this.step(runtime.derive({ labels: [...runtime.labels, label] })));
  }

  at(span: Span | undefined): Check<A> {
    return span === undefined ? this : new Check((runtime) => this.step(runtime.derive({ span })));
  }

  inDocument(uri: string): Check<A> {
    return new Check((runtime) => this.step(runtime.derive({ document: uri })));
  }
}

export const check = <A>(body: () => Generator<Check<unknown>, A, unknown>): Check<A> =>
  new Check((runtime) => {
    const iterator = body();
    let current: IteratorResult<Check<unknown>, A> | undefined;
    try {
      current = iterator.next();
      while (!current.done) {
        const reply = current.value.step(runtime);
        if (!reply.ok) return reply;
        current = iterator.next(reply.value);
      }
      return { ok: true, value: current.value };
    } finally {
      if (current !== undefined && !current.done) {
        const cleanup = iterator.return(undefined as A);
        if (!cleanup.done) throw new TypeError("Checks cannot be yielded during generator cleanup");
      }
    }
  });

export const pure = <A>(value: A): Check<A> => new Check(() => ({ ok: true, value }));
export const fail = (message: string): Check<never> => new Check((runtime) => ({ ok: false, error: runtime.diagnostic(message) }));
export const get = <T>(key: State<T> | Scoped<T>): Check<T> => new Check((runtime) => ({ ok: true, value: runtime.get(key) }));

export const within = <T, A>(key: Scoped<T>, update: (current: T) => T, body: Check<A>): Check<A> =>
  new Check((runtime) => body.step(runtime.derive({ values: new Map(runtime.values).set(key, update(runtime.get(key))) })));

export const bind = <T, A>(env: Scoped<ReadonlyMap<string, T>>, entries: Iterable<readonly [string, T]>, body: Check<A>): Check<A> =>
  within(env, (current) => new Map([...current, ...entries]), body);

export const lookup = <T>(env: Scoped<ReadonlyMap<string, T>>, name: string): Check<T> =>
  get(env).flatMap((current) => current.has(name) ? pure(current.get(name) as T) : fail(`Unbound variable: ${name}`));

type Value<C> = C extends Check<infer A> ? A : never;
type Values<Checks extends readonly Check<unknown>[]> = { -readonly [K in keyof Checks]: Value<Checks[K]> };

export const sequence = <const Checks extends readonly Check<unknown>[]>(checks: Checks): Check<Values<Checks>> =>
  check(function* () {
    const values: unknown[] = [];
    for (const checker of checks) values.push(yield* checker);
    return values as Values<Checks>;
  });

export const attempt = <A>(checker: Check<A>): Check<A> => new Check((runtime) => {
  const start = runtime.storage.errors.length;
  const restore = runtime.checkpoint();
  try {
    const reply = checker.step(runtime);
    const recovered = runtime.storage.errors[start];
    if (reply.ok && recovered === undefined) return reply;
    restore();
    runtime.storage.errors.length = start;
    return recovered === undefined ? reply : { ok: false, error: recovered };
  } catch (error) {
    restore();
    runtime.storage.errors.length = start;
    throw error;
  }
});

export const choice = <const Checks extends readonly [Check<unknown>, ...Check<unknown>[]]>(...checks: Checks): Check<Value<Checks[number]>> =>
  new Check((runtime) => {
    const initial = attempt(checks[0]).step(runtime);
    if (initial.ok) return initial as Reply<Value<Checks[number]>>;
    for (const checker of checks.slice(1)) {
      const reply = attempt(checker).step(runtime);
      if (reply.ok) return reply as Reply<Value<Checks[number]>>;
    }
    return initial;
  });

export const run = <A>(checker: Check<A>): Result<A> => {
  const runtime = new Runtime();
  const reply = checker.step(runtime);
  const errors = runtime.storage.errors;
  if (!reply.ok) {
    const allErrors: [Diagnostic, ...Diagnostic[]] = errors.length === 0
      ? [reply.error]
      : [errors[0]!, ...errors.slice(1), reply.error];
    return { success: false, errors: allErrors };
  }
  return errors.length ? { success: false, errors: [...errors] as [Diagnostic, ...Diagnostic[]] } : { success: true, value: reply.value };
};
