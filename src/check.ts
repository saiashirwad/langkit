import type { Diagnostic, Span } from "./diagnostic.ts"

export type Result<A> =
  | { readonly success: true; readonly value: A }
  | { readonly success: false; readonly error: Diagnostic }

const invariant = Symbol()

export type Scoped<T> = {
  readonly initial: T
  readonly [invariant]: (value: T) => T
}

export const scoped = <T>(initial: T): Scoped<T> => ({
  initial,
  [invariant]: value => value
})

type Runtime = {
  readonly values: ReadonlyMap<object, unknown>
  readonly context: readonly string[]
  readonly span: Span | undefined
}

export class Check<A> {
  readonly step: (runtime: Runtime) => Result<A>

  constructor(step: (runtime: Runtime) => Result<A>) {
    this.step = step
  }

  *[Symbol.iterator](): Generator<Check<A>, A, unknown> {
    // The runner resumes this iterator with this check's result.
    return (yield this) as A
  }

  map<B>(f: (value: A) => B): Check<B> {
    return this.flatMap(value => pure(f(value)))
  }

  flatMap<B>(f: (value: A) => Check<B>): Check<B> {
    return new Check(runtime => {
      const result = this.step(runtime)
      return result.success ? f(result.value).step(runtime) : result
    })
  }

  at(span: Span | undefined): Check<A> {
    return span === undefined ? this : new Check(runtime =>
      this.step({ ...runtime, span })
    )
  }

  context(label: string): Check<A> {
    return new Check(runtime =>
      this.step({ ...runtime, context: [...runtime.context, label] })
    )
  }
}

export const check = <A>(body: () => Generator<Check<unknown>, A, unknown>): Check<A> =>
  new Check(runtime => {
    const iterator = body()
    let done = false
    try {
      let current = iterator.next()
      while (!current.done) {
        const result = current.value.step(runtime)
        if (!result.success) return result
        current = iterator.next(result.value)
      }
      done = true
      return { success: true, value: current.value }
    } finally {
      // Cleanup may run ordinary JS, but cannot perform more checks.
      if (!done && !iterator.return(undefined as A).done) {
        throw new TypeError("Checks cannot be yielded during generator cleanup")
      }
    }
  })

export const pure = <A>(value: A): Check<A> =>
  new Check(() => ({ success: true, value }))

export const fail = (message: string): Check<never> =>
  new Check(runtime => ({
    success: false,
    error: {
      message,
      context: runtime.context,
      ...(runtime.span === undefined ? {} : { span: runtime.span })
    }
  }))

export const get = <T>(key: Scoped<T>): Check<T> =>
  new Check(runtime => ({
    success: true,
    // A key is invariant in T; only within can supply its corresponding value.
    value: runtime.values.has(key) ? runtime.values.get(key) as T : key.initial
  }))

export const within = <T, A>(key: Scoped<T>, value: T, body: Check<A>): Check<A> =>
  new Check(runtime => body.step({
    ...runtime,
    values: new Map(runtime.values).set(key, value)
  }))

export const bind = <T, A>(
  env: Scoped<ReadonlyMap<string, T>>,
  entries: Iterable<readonly [string, T]>,
  body: Check<A>
): Check<A> => get(env).flatMap(current =>
  within(env, new Map([...current, ...entries]), body)
)

export const lookup = <T>(env: Scoped<ReadonlyMap<string, T>>, name: string): Check<T> =>
  get(env).flatMap(current => current.has(name)
    ? pure(current.get(name) as T)
    : fail(`Unbound variable: ${name}`)
  )

export const run = <A>(body: Check<A>): Result<A> =>
  body.step({ values: new Map(), context: [], span: undefined })
