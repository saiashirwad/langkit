import { check, get, scoped, state, within, type Check } from "./check.ts";
import type { Span } from "./diagnostic.ts";

export interface TraceEvent<T, E> {
  readonly id: symbol;
  readonly parent?: symbol;
  readonly rule?: string;
  readonly phase?: "synth" | "check";
  readonly span?: Span;
  readonly document?: string;
  readonly expected?: T;
  readonly synthesized?: T;
  readonly term?: E;
  readonly relation?: string;
  readonly operands?: readonly T[];
  readonly reason?: string;
  readonly causedBy?: readonly symbol[];
}

export const createTrace = <T, E>(snapshotType: (type: T) => T, snapshotTerm: (term: E) => E) => {
  const events = state<TraceEvent<T, E>[]>(() => [], (values) => {
    const length = values.length;
    return () => { values.length = length; };
  });
  const current = scoped<symbol | undefined>(undefined);
  const source = scoped<{ readonly span?: Span; readonly document?: string }>({});
  const record = (event: TraceEvent<T, E>): Check<void> => get(events).map((values) => { values.push(event); });
  return {
    invocation: <A>(event: Omit<TraceEvent<T, E>, "id" | "parent">, body: (id: symbol) => Check<A>): Check<A> => check(function* () {
      const id = Symbol(event.rule);
      const parent = yield* get(current);
      yield* record({ ...event, id, ...(parent === undefined ? {} : { parent }) });
      return yield* within(current, () => id, within(source, () => ({ ...(event.span === undefined ? {} : { span: event.span }), ...(event.document === undefined ? {} : { document: event.document }) }), body(id)));
    }),
    result: (id: symbol, type: T, term: E): Check<void> => record({ id, synthesized: type, term }),
    constrain: <A>(relation: string, operands: readonly T[], reason: string, body: Check<A>, causedBy: readonly symbol[] = []): Check<A> => check(function* () {
      const id = Symbol(relation);
      const parent = yield* get(current);
      const location = yield* get(source);
      yield* record({ id, ...location, relation, operands: [...operands], reason, causedBy: [...causedBy], ...(parent === undefined ? {} : { parent }) });
      return yield* body.mapError((error) => ({ ...error, reasons: [...(error.reasons ?? []), id] }));
    }),
    snapshot: (): Check<readonly TraceEvent<T, E>[]> => get(events).map((values) => values.map((event) => ({
      ...event,
      ...(event.expected === undefined ? {} : { expected: snapshotType(event.expected) }),
      ...(event.synthesized === undefined ? {} : { synthesized: snapshotType(event.synthesized) }),
      ...(event.term === undefined ? {} : { term: snapshotTerm(event.term) }),
      ...(event.operands === undefined ? {} : { operands: event.operands.map(snapshotType) }),
    }))),
  };
};

export type Trace<T, E> = ReturnType<typeof createTrace<T, E>>;
export const traceAt = <T, E>(events: readonly TraceEvent<T, E>[], offset: number): readonly TraceEvent<T, E>[] => {
  const selected = new Set(events.filter((event) => event.span && event.span.start <= offset && offset < event.span.end).map((event) => event.id));
  return events.filter((event) => selected.has(event.id) || (event.parent !== undefined && selected.has(event.parent)));
};
