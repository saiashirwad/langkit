import assert from "node:assert/strict";
import { test } from "node:test";
import { bind, check, fail, get, lookup, pure, run, scoped, within } from "langkit";
import { create, validate, type Body } from "langkit/ir";
import { emit } from "langkit/javascript";
import { runInNewContext } from "node:vm";

const unwrap = <T>(result: ReturnType<typeof run<T>>): T => {
  if (!result.success) throw new Error(result.error.message);
  return result.value;
};

test("checks compose with typed yield results", () => {
  assert.deepEqual(
    run(
      check(function* () {
        const value = yield* pure(20);
        return yield* pure(value + 1).map((value) => value * 2);
      }),
    ),
    { success: true, value: 42 },
  );
});

test("scope is local to a computation", () => {
  const key = scoped(0);
  const computation = check(function* () {
    const inner = yield* within(key, 42, get(key));
    return [inner, yield* get(key)];
  });
  assert.deepEqual(unwrap(run(computation)), [42, 0]);
  assert.deepEqual(unwrap(run(computation)), [42, 0]);
});

test("binding supports shadowing and restores the outer environment", () => {
  const env = scoped<ReadonlyMap<string, number>>(new Map([["x", 1]]));
  assert.deepEqual(
    unwrap(
      run(
        check(function* () {
          const inner = yield* bind(env, [["x", 2]], lookup(env, "x"));
          return [inner, yield* lookup(env, "x")];
        }),
      ),
    ),
    [2, 1],
  );
});

test("failures short circuit and close generators", () => {
  let closed = false;
  let continued = false;
  const result = run(
    check(function* () {
      try {
        yield* fail("no");
        continued = true;
      } finally {
        closed = true;
      }
    })
      .at({ start: 2, end: 3 })
      .context("inner")
      .context("outer"),
  );
  assert.equal(closed, true);
  assert.equal(continued, false);
  assert.deepEqual(result, {
    success: false,
    error: { message: "no", context: ["outer", "inner"], span: { start: 2, end: 3 } },
  });
});

test("programmer exceptions propagate and close parent generators", () => {
  const error = new Error("bug");
  let closed = false;
  assert.throws(
    () =>
      run(
        check(function* () {
          try {
            yield* pure(1).map(() => {
              throw error;
            });
          } finally {
            closed = true;
          }
        }),
      ),
    error,
  );
  assert.equal(closed, true);
});

test("checks in cleanup are rejected rather than silently skipped", () => {
  assert.throws(
    () =>
      run(
        check(function* () {
          try {
            yield* fail("stop");
          } finally {
            yield* pure(1);
          }
        }),
      ),
    /cleanup/,
  );
});

test("body construction can be reused without accumulating declarations", () => {
  const code = create<string>();
  const computation = code.body(
    check(function* () {
      return yield* code.declare("x", code.literal("number", 42));
    }),
  );
  const first = unwrap(run(computation));
  const second = unwrap(run(computation));
  assert.equal(first.declarations.length, 1);
  assert.equal(second.declarations.length, 1);
  assert.notEqual(first.declarations[0]!.binding.id, second.declarations[0]!.binding.id);
  assert.equal(emit(first), emit(second));
});

test("reference types can vary without changing binding identity or scope", () => {
  const code = create<string>();
  const binding = code.binding("id", "a -> a");
  const numeric = code.ref(binding, "number -> number");
  const boolean = code.ref(binding, "boolean -> boolean");
  assert.equal(code.ref(binding).type, "a -> a");
  assert.equal(numeric.type, "number -> number");
  assert.equal(boolean.type, "boolean -> boolean");
  assert.equal(numeric.node.binding, binding);
  assert.equal(boolean.node.binding, binding);
  assert.equal(binding.type, "a -> a");
  assert.throws(() => validate({ declarations: [], result: numeric }), /Out-of-scope/);
  const param = code.binding("x", "a");
  const initial = code.fn("a -> a", param, { declarations: [], result: code.ref(param) });
  const body = {
    declarations: [{ binding, value: initial }],
    result: code.call("number", numeric, code.literal("number", 42)),
  };
  assert.equal(runInNewContext(emit(body)), 42);
});

test("declare needs an explicit construction body", () => {
  const code = create<string>();
  assert.throws(() => run(code.declare("x", code.literal("number", 1))), /enclosing body/);
});

test("scope extrusion is rejected before emission", () => {
  const code = create<string>();
  const escaped = code.binding("escaped", "number");
  const body: Body<string> = { declarations: [], result: code.ref(escaped) };
  assert.throws(() => emit(body), /Out-of-scope binding: escaped/);
});

test("a declaration cannot reference itself or a later binding", () => {
  const code = create<string>();
  const x = code.binding("x", "number");
  assert.throws(
    () =>
      validate({
        declarations: [{ binding: x, value: code.ref(x) }],
        result: code.ref(x),
      }),
    /Out-of-scope/,
  );
});

test("duplicate binding identities are rejected", () => {
  const code = create<string>();
  const x = code.binding("x", "number");
  const declaration = { binding: x, value: code.literal("number", 1) };
  assert.throws(
    () => validate({ declarations: [declaration, declaration], result: code.ref(x) }),
    /declared twice/,
  );
});

test("emission makes hostile and colliding name hints harmless", () => {
  const code = create<string>();
  const body = unwrap(
    run(
      code.body(
        check(function* () {
          const a = yield* code.declare("x); throw 1; //", code.literal("number", 20));
          const b = yield* code.declare("x); throw 1; //", code.literal("number", 22));
          return code.binary("number", "+", a, b);
        }),
      ),
    ),
  );
  assert.equal(runInNewContext(emit(body)), 42);
});

test("conditional bodies run only in the selected branch", () => {
  const code = create<string>();
  const param = code.binding("x", "number");
  // Deliberately malformed target operation would throw if the branch ran.
  const bad: Body<string> = {
    declarations: [],
    result: code.call("number", code.literal("number", 0), code.literal("number", 1)),
  };
  const good: Body<string> = { declarations: [], result: code.literal("number", 42) };
  const result: Body<string> = {
    declarations: [],
    result: code.conditional("number", code.literal("boolean", true), good, bad),
  };
  assert.equal(runInNewContext(emit(result)), 42);
  const fn = code.fn("fn", param, { declarations: [], result: code.ref(param) });
  assert.equal(
    runInNewContext(
      emit({ declarations: [], result: code.call("number", fn, code.literal("number", 42)) }),
    ),
    42,
  );
});

test("IR declaration scopes preserve left-to-right evaluation", () => {
  const code = create<string>();
  const bad = code.call("number", code.literal("number", 11), code.literal("number", 0));
  const later = unwrap(
    run(
      code.scope(
        check(function* () {
          return yield* code.declare(
            "later",
            code.call("number", code.literal("number", 22), code.literal("number", 0)),
          );
        }),
      ),
    ),
  );
  const js = emit({ declarations: [], result: code.binary("number", "+", bad, later) });
  assert.throws(() => runInNewContext(js), /11 is not a function/);
});
