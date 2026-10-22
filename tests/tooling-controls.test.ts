import assert from "node:assert/strict";
import { test } from "node:test";
import { observe, position, type Probe, validate, validateResponse } from "../tools/editor-contracts.ts";
import { fragment } from "../tools/type-contracts.ts";
import { parseMetrics } from "../tools/type-profile.ts";

const hover: Probe = {
  id: "control",
  method: "hover",
  anchor: "probe",
  offset: 1,
  require: ["\"ready\""],
  maxLength: 100,
};

test("editor probe anchors reject missing, ambiguous and out-of-range locations", () => {
  assert.deepEqual(position("\nprobe", hover), { line: 1, character: 1 });
  assert.throws(() => position("nothing", hover), /anchor missing/);
  assert.throws(() => position("probe probe", hover), /anchor ambiguous/);
  assert.throws(() => position("probe", { ...hover, offset: 6 }), /invalid offset/);
  assert.deepEqual(position("call(\n  value\n)", { ...hover, anchor: "call(value)", offset: 6 }), {
    line: 1,
    character: 3,
  });
  assert.deepEqual(fragment("prove<\n Equal<A, B>\n>();", "prove<Equal<A, B>>();"), {
    index: 0,
    text: "prove<\n Equal<A, B>\n>();",
  });
});

test("protocol-invalid responses cannot masquerade as valid observations", () => {
  for (
    const response of [null, {}, { jsonrpc: "1.0", id: 1, result: null }, { jsonrpc: "2.0", id: 1 }, {
      jsonrpc: "2.0",
      id: 1,
      result: null,
      error: {},
    }, { jsonrpc: "2.0", id: {}, result: null }]
  ) assert.throws(() => validateResponse(response));
  validateResponse({ jsonrpc: "2.0", id: 1, result: null });
  assert.throws(() => observe(hover, { contents: { value: 42 } }), /invalid hover text/);
  assert.throws(() => observe({ ...hover, method: "completion" }, { items: [{}] }), /invalid completion label/);
});

test("hover and completion gates reject degraded, excessive and invalid member results", () => {
  validate(hover, { text: "const value: \"ready\"" });
  for (
    const text of [
      "const value: any",
      "const value: never",
      "\"ready\" any",
      "\"ready\" ... 3 more",
      "\"ready\" …",
      `"ready"${" ".repeat(101)}`,
    ]
  ) assert.throws(() => validate(hover, { text }), /missing|degraded|oversized/);
  const completion: Probe = { ...hover, method: "completion", require: ["fields"], forbid: ["binding"] };
  assert.throws(
    () => validate(completion, { text: "fields\nbinding", labels: ["fields", "binding"] }),
    /unexpected completion/,
  );
  assert.throws(() => validate(completion, { text: "binding", labels: ["binding"] }), /missing fields/);
});

test("type profile requires actual metrics", () => {
  assert.throws(() => parseMetrics("Types: 1"), /missing metric/);
  assert.deepEqual(
    parseMetrics("Types: 10\nInstantiations: 20\nCheck time: 0.01s\nTotal time: 0.02s\nMemory used: 30K\n"),
    { types: 10, instantiations: 20, checkSeconds: 0.01, totalSeconds: 0.02, memoryBytes: 30720 },
  );
});
