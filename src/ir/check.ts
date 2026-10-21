import { Check, check, get, scoped, within } from "../check.ts";
import { push } from "../inference.ts";
import type { Body, Declaration, LanguageBuilder, Value } from "../ir.ts";

type MixedGenerator<T, A> = () => Generator<Check<unknown> | Declaration<T>, A, unknown>;
type Elaborated<T, A> = Check<A> | MixedGenerator<T, A>;

export type Elaboration<T, Methods extends object> = Omit<LanguageBuilder<T, Methods>, "use" | "body" | "scope"> & {
  readonly check: <A>(factory: MixedGenerator<T, A>) => Check<A>;
  readonly body: <A extends Value<T>>(source: Elaborated<T, A>) => Check<Body<T>>;
  readonly scope: <A extends Value<T>>(source: Elaborated<T, A>) => Check<Value<T>>;
};

/** Lets IR body generators also yield checks, so diagnostics and declarations share one generator. */
type BodyMethods<T> = { body(source: Body<T>): Body<T>; scope(source: Body<T>): Value<T>; };

export const elaboration = <T, Methods extends BodyMethods<T>>(
  builder: LanguageBuilder<T, Methods>,
): Elaboration<T, Methods> => {
  const active = scoped<Declaration<T>[] | undefined>(undefined);
  const mixed = <A>(factory: MixedGenerator<T, A>): Check<A> =>
    check(function*() {
      const iterator = factory();
      let declarations: Declaration<T>[] | undefined;
      let done = false;
      try {
        let step = iterator.next();
        while (!step.done) {
          if (step.value instanceof Check) {
            step = iterator.next(yield* step.value);
            continue;
          }
          declarations ??= yield* get(active);
          if (declarations === undefined) throw new Error("IR declarations need an enclosing body");
          yield* push(declarations, step.value);
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
  const body = <A extends Value<T>>(source: Elaborated<T, A>): Check<Body<T>> =>
    check(function*() {
      const declarations: Declaration<T>[] = [];
      const result = yield* within(active, () => declarations, source instanceof Check ? source : mixed(source));
      return builder.body({ declarations: [...declarations], result });
    });
  const { use: _, ...pure } = builder;
  return {
    ...pure,
    check: mixed,
    body,
    scope: <A extends Value<T>>(source: Elaborated<T, A>) => body(source).map(builder.scope),
  } as Elaboration<T, Methods>;
};
