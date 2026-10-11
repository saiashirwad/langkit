import assert from "node:assert/strict";
import test from "node:test";
import { Check, attempt, check, choice, diagnostics, fail, get, pure, runDetailed, sequence, state } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { createTrace } from "../src/trace.ts";

const reenter = <A>(child: Check<A>): Check<A> => new Check((runtime) => child.step(runtime));
const suffix = (text: string) => (error: Diagnostic): Diagnostic => ({ ...error, message: error.message + text });
const composite = (): Check<never> => pure(0).flatMap(() => fail("bad"));

test("composite step rereturn maps a terminal diagnostic exactly once", () => {
  assert.deepEqual(runDetailed(reenter(composite()).withDiagnostics(suffix("!"))), {
    status: "failed", diagnostics: [{ message: "bad!", context: [] }],
  });
  assert.equal(runDetailed(reenter(fail("bad")).withDiagnostics(suffix("!"))).diagnostics[0]?.message, "bad!");
});

test("recovered inner failures are mapped before returning from step", () => {
  const child = composite().recover(pure(7)).flatMap((value) => diagnostics().map((errors) => {
    assert.equal(errors[0]?.message, "bad!");
    return value;
  }));
  assert.deepEqual(runDetailed(reenter(child).withDiagnostics(suffix("!"))), {
    status: "completed", value: 7, diagnostics: [{ message: "bad!", context: [] }],
  });
});

test("nested scoped mappers preserve inner to outer order through reentry", () => {
  const child = reenter(composite()).withDiagnostics(suffix("I"));
  assert.equal(runDetailed(reenter(child).withDiagnostics(suffix("O"))).diagnostics[0]?.message, "badIO");
});

test("scope identity is distinct even when nested scopes share one callback", () => {
  const map = suffix("!");
  const child = composite().withDiagnostics(map).withDiagnostics(map);
  assert.equal(runDetailed(reenter(child)).diagnostics[0]?.message, "bad!!");
});

test("mapError replacements retain scoped mapper provenance", () => {
  const child = composite().mapError((error) => ({ message: `${error.message}?`, context: ["replacement"] }));
  assert.deepEqual(runDetailed(reenter(child).withDiagnostics(suffix("!"))), {
    status: "failed", diagnostics: [{ message: "bad!?", context: ["replacement"] }],
  });
});

test("a repeated Check allocates distinct mapping scopes within and between runs", () => {
  const shared: Diagnostic = { message: "bad", context: [] };
  const child = reenter(pure(0).flatMap(() => new Check<never>(() => ({ ok: false, error: shared })))).withDiagnostics(suffix("!"));
  const program = sequence([child.recover(pure(1)), child.recover(pure(2))]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(runDetailed(program).diagnostics.map(({ message }) => message), ["bad!", "bad!"]);
  }
  assert.deepEqual(shared, { message: "bad", context: [] });
});

test("new failures in one scope each map normally", () => {
  const program = reenter(composite().recover(pure(1)).flatMap(() => composite())).withDiagnostics(suffix("!"));
  assert.deepEqual(runDetailed(program).diagnostics.map(({ message }) => message), ["bad!", "bad!"]);
});

for (const innerIdentity of [false, true]) {
  test(`reusing a raw diagnostic in one scope preserves transformations, identity scope=${innerIdentity}`, () => {
    const error: Diagnostic = { message: "bad", context: [] };
    const raw = new Check<never>(() => ({ ok: false, error }));
    const child = innerIdentity ? raw.withDiagnostics(value => value) : raw;
    const program = sequence([child.recover(pure(1)), child.recover(pure(2))]).withDiagnostics(suffix("!"));
    assert.deepEqual(runDetailed(program).diagnostics.map(({ message }) => message), ["bad!", "bad!"]);
    assert.equal(error.message, "bad");
  });
}

test("attempt and choice keep mapped terminal failures without replaying scopes", () => {
  const program = reenter(choice(attempt(composite().recover(pure(1))), composite())).withDiagnostics(suffix("!"));
  assert.deepEqual(runDetailed(program).diagnostics.map(({ message }) => message), ["bad!"]);
});

test("trace constraint causes are unique through custom step reentry", () => {
  const trace = createTrace<string, string>((value) => value, (value) => value);
  const program = trace.constrain("outer", [], "outer", reenter(trace.constrain("inner", [], "inner", reenter(composite()))));
  const result = runDetailed(program);
  const reasons = result.diagnostics[0]?.reasons;
  assert.equal(reasons?.length, 2);
  assert.equal(new Set(reasons).size, 2);
});

test("retained rolled-back errors do not inherit later constraint identities", () => {
  const trace = createTrace<string, string>((value) => value, (value) => value);
  let retained: Diagnostic | undefined;
  const capture = new Check<number>((runtime) => {
    const reply = trace.constrain("trial", [], "trial", composite()).step(runtime);
    if (!reply.ok) retained = reply.error;
    return reply;
  });
  const rereturn = new Check<never>(() => ({ ok: false, error: retained! }));
  const result = runDetailed(attempt(capture).recover(pure(0)).flatMap(() => trace.constrain("later", [], "later", rereturn)));
  assert.equal(retained?.reasons?.length, 1);
  assert.equal(result.diagnostics[1]?.reasons?.length, 2);
  assert.notEqual(result.diagnostics[1]?.reasons?.[1], retained?.reasons?.[0]);
});

for (const mapping of ["scoped", "mapError"] as const) {
  for (const transaction of ["atomic", "attempt"] as const) {
    test(`${mapping} exceptions unwind generators and restore ${transaction} state`, () => {
      const external = { value: 0 };
      const cell = state(() => external, (value) => {
        const saved = value.value;
        return () => { value.value = saved; };
      });
      const exception = new Error("mapping bug");
      let closed = 0;
      const body = check(function* () {
        try {
          yield* fail("recovered").recover(pure(0));
          yield* get(cell).map((value) => { value.value = 1; });
          return yield* composite();
        } finally { closed += 1; }
      });
      const map = (error: Diagnostic): Diagnostic => {
        if (error.message === "bad") throw exception;
        return error;
      };
      const mapped = mapping === "scoped" ? body.withDiagnostics(map) : body.mapError(map);
      const trial = transaction === "atomic" ? mapped.atomic() : attempt(mapped);
      const observer = new Check((runtime) => {
        assert.throws(() => trial.step(runtime), (error) => error === exception);
        assert.equal(external.value, 0);
        assert.equal(closed, 1);
        const reply = diagnostics().step(runtime);
        assert.equal(reply.ok, true);
        if (reply.ok) assert.equal(reply.value.length, transaction === "attempt" ? 0 : 1);
        const after = composite().step(runtime);
        assert.deepEqual(after, { ok: false, error: { message: "bad", context: [] } });
        return { ok: true, value: undefined };
      });
      assert.equal(runDetailed(observer).status, "completed");
      assert.throws(() => runDetailed(reenter(trial)), (error) => error === exception);
      assert.equal(external.value, 0);
      assert.equal(closed, 2);
    });
  }
}

test("20k mapping scopes share linear provenance and remain stack safe", () => {
  let child: Check<never> = composite();
  for (let i = 0; i < 20_000; i++) child = child.withDiagnostics(suffix("!"));
  for (let i = 0; i < 20_000; i++) child = child.mapError((error) => ({ ...error }));
  const result = runDetailed(reenter(child).withDiagnostics(suffix("?")));
  assert.equal(result.diagnostics[0]?.message, `bad${"!".repeat(20_000)}?`);
});
