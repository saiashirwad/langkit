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

type Instruction =
  | { readonly kind: "primitive"; readonly step: (runtime: Runtime) => Reply<unknown> }
  | { readonly kind: "bind"; readonly child: Check<unknown>; readonly next: (value: unknown) => Check<unknown> }
  | { readonly kind: "generator"; readonly body: () => Generator<Check<unknown>, unknown, unknown> }
  | { readonly kind: "scoped"; readonly child: Check<unknown>; readonly derive: (runtime: Runtime) => Runtime }
  | { readonly kind: "recovery"; readonly child: Check<unknown>; readonly fallback: Check<unknown> }
  | { readonly kind: "transaction"; readonly child: Check<unknown>; readonly speculative: boolean }
  | { readonly kind: "mapError"; readonly child: Check<unknown>; readonly map: (error: Diagnostic) => Diagnostic }
  | { readonly kind: "choice"; readonly children: readonly Check<unknown>[] };

type Completion = Reply<unknown> | { readonly kind: "throw"; readonly error: unknown };
type Frame =
  | { readonly kind: "mapError"; readonly map: (error: Diagnostic) => Diagnostic }
  | { readonly kind: "bind"; readonly next: (value: unknown) => Check<unknown> }
  | { readonly kind: "generator"; readonly iterator: Generator<Check<unknown>, unknown, unknown> }
  | { readonly kind: "scoped"; readonly outer: Runtime }
  | { readonly kind: "recovery"; readonly fallback: Check<unknown> }
  | { readonly kind: "transaction"; readonly restore: () => void; readonly start: number; readonly speculative: boolean }
  | { readonly kind: "choice"; readonly children: readonly Check<unknown>[]; readonly index: number; readonly first: Reply<unknown> | undefined };

const instructions = new WeakMap<Check<unknown>, Instruction>();
const instructed = <A>(instruction: Instruction): Check<A> => {
  const checker: Check<A> = new Check<A>((runtime) => evaluate(checker, runtime));
  instructions.set(checker, instruction);
  return checker;
};

const evaluate = <A>(checker: Check<A>, initial: Runtime): Reply<A> => {
  let runtime = initial;
  let current: Check<unknown> | undefined = checker;
  let completion: Completion = { ok: true, value: undefined };
  const frames: Frame[] = [];
  const advance = (iterator: Generator<Check<unknown>, unknown, unknown>, value?: unknown) => {
    const result = iterator.next(value);
    if (result.done) completion = { ok: true, value: result.value };
    else {
      frames.push({ kind: "generator", iterator });
      current = result.value;
    }
  };
  while (current !== undefined || frames.length > 0) {
    try {
      if (current !== undefined) {
        const instruction: Instruction = instructions.get(current)!;
        current = undefined;
        switch (instruction.kind) {
          case "primitive": completion = instruction.step(runtime); break;
          case "mapError": frames.push({ kind: "mapError", map: instruction.map }); current = instruction.child; break;
          case "bind": frames.push({ kind: "bind", next: instruction.next }); current = instruction.child; break;
          case "generator": advance(instruction.body()); break;
          case "scoped": {
            const inner = instruction.derive(runtime);
            frames.push({ kind: "scoped", outer: runtime });
            runtime = inner;
            current = instruction.child;
            break;
          }
          case "recovery": frames.push({ kind: "recovery", fallback: instruction.fallback }); current = instruction.child; break;
          case "transaction": {
            const start = runtime.storage.errors.length;
            const restore = runtime.checkpoint();
            frames.push({ kind: "transaction", restore, start, speculative: instruction.speculative });
            current = instruction.child;
            break;
          }
          case "choice":
            frames.push({ kind: "choice", children: instruction.children, index: 0, first: undefined });
            current = attempt(instruction.children[0]!);
            break;
        }
      } else {
        const frame = frames.pop()!;
        switch (frame.kind) {
          case "bind": if (!("kind" in completion) && completion.ok) current = frame.next(completion.value); break;
          case "mapError": if (!("kind" in completion) && !completion.ok) completion = { ok: false, error: frame.map(completion.error) }; break;
          case "generator":
            if (!("kind" in completion) && completion.ok) advance(frame.iterator, completion.value);
            else if (!frame.iterator.return(undefined).done) throw new TypeError("Checks cannot be yielded during generator cleanup");
            break;
          case "scoped": runtime = frame.outer; break;
          case "recovery":
            if (!("kind" in completion) && !completion.ok) {
              runtime.storage.errors.push(completion.error);
              current = frame.fallback;
            }
            break;
          case "transaction": {
            const recovered = frame.speculative ? runtime.storage.errors[frame.start] : undefined;
            if ("kind" in completion || !completion.ok || recovered !== undefined) {
              try { frame.restore(); } finally {
                if (frame.speculative) runtime.storage.errors.length = frame.start;
              }
              if (!("kind" in completion) && recovered !== undefined) completion = { ok: false, error: recovered };
            }
            break;
          }
          case "choice":
            if (!("kind" in completion) && !completion.ok) {
              const first: Reply<unknown> = frame.first ?? completion;
              const index = frame.index + 1;
              if (index === frame.children.length) completion = first;
              else {
                frames.push({ ...frame, first, index });
                current = attempt(frame.children[index]!);
              }
            }
            break;
        }
      }
    } catch (error) {
      current = undefined;
      completion = { kind: "throw", error };
    }
  }
  if ("kind" in completion) throw completion.error;
  return completion as Reply<A>;
};

export class Check<A> {
  readonly step: (runtime: Runtime) => Reply<A>;

  constructor(step: (runtime: Runtime) => Reply<A>) {
    this.step = step;
    instructions.set(this, { kind: "primitive", step });
  }
  *[Symbol.iterator](): Generator<Check<A>, A, unknown> { return (yield this) as A; }

  map<B>(f: (value: A) => B): Check<B> {
    return this.flatMap((value) => pure(f(value)));
  }

  mapError(map: (error: Diagnostic) => Diagnostic): Check<A> {
    return instructed({ kind: "mapError", child: this, map });
  }

  flatMap<B>(f: (value: A) => Check<B>): Check<B> {
    return instructed({ kind: "bind", child: this, next: (value) => f(value as A) });
  }

  recover<B>(fallback: Check<B>): Check<A | B>;
  recover(this: Check<void>): Check<void>;
  recover(fallback: Check<unknown> = pure(undefined)): Check<unknown> {
    return instructed({ kind: "recovery", child: this, fallback });
  }

  atomic(): Check<A> {
    return instructed({ kind: "transaction", child: this, speculative: false });
  }

  context(label: string): Check<A> {
    return instructed({ kind: "scoped", child: this, derive: (runtime) => runtime.derive({ labels: [...runtime.labels, label] }) });
  }

  at(span: Span | undefined): Check<A> {
    return span === undefined ? this : instructed({ kind: "scoped", child: this, derive: (runtime) => runtime.derive({ span }) });
  }

  inDocument(uri: string): Check<A> {
    return instructed({ kind: "scoped", child: this, derive: (runtime) => runtime.derive({ document: uri }) });
  }
}

export const check = <A>(body: () => Generator<Check<unknown>, A, unknown>): Check<A> =>
  instructed({ kind: "generator", body });

export const pure = <A>(value: A): Check<A> => new Check(() => ({ ok: true, value }));
export const fail = (message: string): Check<never> => new Check((runtime) => ({ ok: false, error: runtime.diagnostic(message) }));
export const get = <T>(key: State<T> | Scoped<T>): Check<T> => new Check((runtime) => ({ ok: true, value: runtime.get(key) }));

export const within = <T, A>(key: Scoped<T>, update: (current: T) => T, body: Check<A>): Check<A> =>
  instructed({ kind: "scoped", child: body, derive: (runtime) => runtime.derive({ values: new Map(runtime.values).set(key, update(runtime.get(key))) }) });

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

export const attempt = <A>(checker: Check<A>): Check<A> => instructed({ kind: "transaction", child: checker, speculative: true });

export const choice = <const Checks extends readonly [Check<unknown>, ...Check<unknown>[]]>(...checks: Checks): Check<Value<Checks[number]>> =>
  instructed({ kind: "choice", children: checks });

export const run = <A>(checker: Check<A>): Result<A> => {
  const runtime = new Runtime();
  const reply = evaluate(checker, runtime);
  const errors = runtime.storage.errors;
  if (!reply.ok) {
    const allErrors: [Diagnostic, ...Diagnostic[]] = errors.length === 0
      ? [reply.error]
      : [errors[0]!, ...errors.slice(1), reply.error];
    return { success: false, errors: allErrors };
  }
  return errors.length ? { success: false, errors: [...errors] as [Diagnostic, ...Diagnostic[]] } : { success: true, value: reply.value };
};

export type DetailedResult<A> =
  | { readonly status: "completed"; readonly value: A; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "failed"; readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]] };

export const runDetailed = <A>(checker: Check<A>): DetailedResult<A> => {
  const runtime = new Runtime();
  const reply = evaluate(checker, runtime);
  const diagnostics = [...runtime.storage.errors];
  return reply.ok
    ? { status: "completed", value: reply.value, diagnostics }
    : { status: "failed", diagnostics: diagnostics.length ? [diagnostics[0]!, ...diagnostics.slice(1), reply.error] : [reply.error] };
};

export const diagnostics = (): Check<readonly Diagnostic[]> =>
  new Check((runtime) => ({ ok: true, value: [...runtime.storage.errors] }));
