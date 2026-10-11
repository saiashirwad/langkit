import { Check, check, get, scoped, state, within, type Scoped, type State } from "../check.ts";
import type { Body, Declaration, LanguageBuilder, Value } from "../ir.ts";

type MixedGenerator<T, A> = () => Generator<Check<unknown> | Declaration<T>, A, unknown>;
type PureMethods<T, Methods extends object> = Omit<
  LanguageBuilder<T, Methods>,
  "use" | "body" | "scope" | "declare" | "declareRecursive"
>;

export type Elaboration<T, Methods extends object> = PureMethods<T, Methods> & {
  readonly check: <A>(factory: MixedGenerator<T, A>) => Check<A>;
  readonly body: <A extends Value<T>>(factory: MixedGenerator<T, A>) => Check<Body<T>>;
  readonly scope: <A extends Value<T>>(factory: MixedGenerator<T, A>) => Check<Value<T>>;
  readonly declare: LanguageBuilder<T, Methods>["declare"];
  readonly declareRecursive: LanguageBuilder<T, Methods>["declareRecursive"];
};

const runMixed = <T, A>(factory: MixedGenerator<T, A>, active: Scoped<State<Declaration<T>[]> | undefined>): Check<A> =>
  check(function* () {
    const iterator = factory();
    let done = false;
    try {
      let step = iterator.next();
      while (!step.done) {
        if (step.value instanceof Check) {
          step = iterator.next(yield* step.value);
        } else {
          const collection = yield* get(active);
          if (collection === undefined) throw new Error("IR declarations need an enclosing body");
          const declaration = step.value as Declaration<T>;
          const declarations = yield* get(collection);
          declarations.push(declaration);
          step = iterator.next(undefined);
        }
      }
      done = true;
      return step.value;
    } finally {
      if (!done && !iterator.return(undefined as A).done) {
        throw new TypeError("IR elaboration cleanup cannot yield values");
      }
    }
  });

/** Bridges pure generator IR into diagnostics without introducing a second declaration protocol. */
export const elaboration = <T, Methods extends object>(builder: LanguageBuilder<T, Methods>): Elaboration<T, Methods> => {
  const active = scoped<State<Declaration<T>[]> | undefined>(undefined);
  const checkFactory = <A>(factory: MixedGenerator<T, A>): Check<A> => runMixed(factory, active);
  const body = <A extends Value<T>>(factory: MixedGenerator<T, A>): Check<Body<T>> => {
    const collection = state<Declaration<T>[]>(() => [], (current) => {
      const length = current.length;
      return () => { current.length = length; };
    });
    const computation = check(function* () {
      const result = yield* runMixed(factory, active);
      const declarations = yield* get(collection);
      return builder.body({ declarations, result });
    });
    return within(active, () => collection, computation);
  };
  const scope = <A extends Value<T>>(factory: MixedGenerator<T, A>): Check<Value<T>> =>
    body(factory).map((built) => builder.block(built.result.type, built));
  const api = { ...builder } as PureMethods<T, Methods> & Record<string, unknown>;
  delete api.use;
  delete api.body;
  delete api.scope;
  delete api.declare;
  delete api.declareRecursive;
  Object.assign(api, {
    check: checkFactory,
    body,
    scope,
    declare: builder.declare,
    declareRecursive: builder.declareRecursive,
  });
  return api as Elaboration<T, Methods>;
};
