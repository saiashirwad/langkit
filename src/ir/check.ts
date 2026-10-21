import { Check, check, get, scoped, type State, state, within } from "../check.ts";
import type { Body, Declaration, LanguageBuilder, Value } from "../ir.ts";

type MixedGenerator<T, A> = () => Generator<Check<unknown> | Declaration<T>, A, unknown>;

export type Elaboration<T, Methods extends object> = Omit<LanguageBuilder<T, Methods>, "use" | "body" | "scope"> & {
  readonly check: <A>(factory: MixedGenerator<T, A>) => Check<A>;
  readonly body: <A extends Value<T>>(factory: MixedGenerator<T, A>) => Check<Body<T>>;
  readonly scope: <A extends Value<T>>(factory: MixedGenerator<T, A>) => Check<Value<T>>;
};

/** Lets IR body generators also yield checks, so diagnostics and declarations share one generator. */
export const elaboration = <T, Methods extends object>(
  builder: LanguageBuilder<T, Methods>,
): Elaboration<T, Methods> => {
  const active = scoped<State<Declaration<T>[]> | undefined>(undefined);
  const mixed = <A>(factory: MixedGenerator<T, A>): Check<A> =>
    check(function*() {
      const iterator = factory();
      let done = false;
      try {
        let step = iterator.next();
        while (!step.done) {
          if (step.value instanceof Check) {
            step = iterator.next(yield* step.value);
            continue;
          }
          const collection = yield* get(active);
          if (collection === undefined) throw new Error("IR declarations need an enclosing body");
          (yield* get(collection)).push(step.value);
          step = iterator.next(undefined);
        }
        done = true;
        return step.value;
      } finally {
        if (!done && !iterator.return(undefined as A).done) {
          throw new TypeError("IR elaboration cleanup cannot yield values");
        }
      }
    });
  const body = <A extends Value<T>>(factory: MixedGenerator<T, A>): Check<Body<T>> =>
    check(function*() {
      const collection = state<Declaration<T>[]>(() => [], (current) => {
        const length = current.length;
        return () => {
          current.length = length;
        };
      });
      const result = yield* within(active, () => collection, mixed(factory));
      return builder.body({ declarations: [...yield* get(collection)], result });
    });
  const { use: _, ...pure } = builder;
  return {
    ...pure,
    check: mixed,
    body,
    scope: (factory) => body(factory).map((built) => builder.block(built.result.type, built)),
  } as Elaboration<T, Methods>;
};
