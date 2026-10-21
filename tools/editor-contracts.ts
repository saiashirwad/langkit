import assert from "node:assert/strict";

export type Probe = {
  id: string;
  method: "hover" | "completion" | "signatureHelp";
  anchor: string;
  offset: number;
  target?: string;
  require: readonly string[];
  forbid?: readonly string[];
  maxLength?: number;
  activeParameter?: number;
};
export const editorFile = "tests/editor-consumer.ts";
export const probes: readonly Probe[] = [
  {
    id: "narrowed-record",
    method: "hover",
    anchor: "const recordValue = value",
    offset: 6,
    require: ["readonly kind: \"record\"", "readonly fields: readonly RecordField<rank.Type>[]"],
    maxLength: 400,
  },
  {
    id: "narrowed-literal",
    method: "hover",
    anchor: "const literalValue = value",
    offset: 6,
    require: ["readonly kind: \"literal\"", "readonly value: number | boolean | string"],
    maxLength: 400,
  },
  {
    id: "fresh-variable",
    method: "hover",
    anchor: "const variable =",
    offset: 8,
    require: ["Variable"],
    maxLength: 120,
  },
  {
    id: "yield-literal",
    method: "hover",
    anchor: "const yielded =",
    offset: 8,
    require: ["\"ready\""],
    maxLength: 120,
  },
  {
    id: "yield-tuple",
    method: "hover",
    anchor: "const tuple =",
    offset: 8,
    require: ["[\"label\", 42, true]"],
    maxLength: 160,
  },
  {
    id: "named-value",
    method: "hover",
    anchor: "const namedValue:",
    offset: 9,
    require: ["Value<rank.Type>"],
    maxLength: 160,
  },
  {
    id: "named-check",
    method: "hover",
    anchor: "const namedCheck:",
    offset: 9,
    require: ["Check<Value<rank.Type>>"],
    maxLength: 160,
  },
  {
    id: "record-fields",
    method: "hover",
    anchor: "return recordValue.fields",
    offset: 20,
    require: ["readonly RecordField<rank.Type>[]"],
    maxLength: 200,
  },
  {
    id: "record-field-name",
    method: "hover",
    anchor: "${field.name}",
    offset: 9,
    require: ["name: string"],
    maxLength: 160,
  },
  {
    id: "record-field-value",
    method: "hover",
    anchor: "describe(field.value)",
    offset: 17,
    require: ["value: Value<rank.Type>"],
    maxLength: 160,
  },
  {
    id: "literal-value",
    method: "hover",
    anchor: "JSON.stringify(literalValue.value)",
    offset: 29,
    require: ["string | number | boolean"],
    maxLength: 200,
  },
  {
    id: "record-members",
    method: "completion",
    anchor: "return recordValue.fields",
    offset: 19,
    require: ["kind", "fields", "base", "type", "span"],
    forbid: ["value", "left", "right", "binding"],
  },
  {
    id: "literal-members",
    method: "completion",
    anchor: "JSON.stringify(literalValue.value)",
    offset: 28,
    require: ["kind", "value", "type", "span"],
    forbid: ["fields", "base", "binding"],
  },
  {
    id: "record-field-members",
    method: "completion",
    anchor: "${field.name}",
    offset: 8,
    require: ["name", "value"],
    forbid: ["kind", "fields", "base"],
  },
  {
    id: "literal-signature",
    method: "signatureHelp",
    anchor: "language.literal(rank.number, 42)",
    offset: 30,
    require: ["type: rank.Type", "value: number | boolean | string"],
    activeParameter: 1,
  },
];

export function position(source: string, probe: Probe): { line: number; character: number; } {
  const indices = [...source.matchAll(/\S/g)].map((match) => match.index);
  const compact = indices.map((index) => source[index]).join("");
  const anchor = probe.anchor.replace(/\s/g, "");
  const start = compact.indexOf(anchor);
  assert.notEqual(start, -1, `${probe.id}: anchor missing`);
  assert.equal(compact.indexOf(anchor, start + 1), -1, `${probe.id}: anchor ambiguous`);
  const target = probe.target === undefined
    ? start
    : compact.indexOf(probe.target.replace(/\s/g, ""), start + anchor.length);
  assert.notEqual(target, -1, `${probe.id}: target missing`);
  assert.ok(probe.offset >= 0 && probe.offset <= (probe.target ?? probe.anchor).length, `${probe.id}: invalid offset`);
  const offset = (probe.target ?? probe.anchor).slice(0, probe.offset).replace(/\s/g, "").length;
  const lines = source.slice(0, indices[target + offset] ?? source.length).split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export function record(value: unknown, message: string): asserts value is Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), message);
}

export function validateResponse(message: unknown): asserts message is Record<string, unknown> {
  record(message, "invalid LSP message");
  assert.equal(message.jsonrpc, "2.0", "invalid JSON-RPC version");
  assert.ok(
    message.id === undefined || typeof message.id === "number" || typeof message.id === "string",
    "invalid response id",
  );
  if (message.method !== undefined) assert.equal(typeof message.method, "string", "invalid method");
  else {
    assert.notEqual(message.id, undefined, "response requires id");
    assert.notEqual(
      Object.hasOwn(message, "result"),
      Object.hasOwn(message, "error"),
      "response requires exactly result or error",
    );
  }
}

export function observe(probe: Probe, result: unknown): { text: string; labels?: string[]; activeParameter?: number; } {
  record(result, `${probe.id}: invalid ${probe.method} result`);
  if (probe.method === "hover") {
    record(result.contents, `${probe.id}: invalid hover contents`);
    assert.equal(typeof result.contents.value, "string", `${probe.id}: invalid hover text`);
    return { text: String(result.contents.value).replaceAll("\r\n", "\n").trim() };
  }
  if (probe.method === "completion") {
    assert.ok(Array.isArray(result.items), `${probe.id}: invalid completion items`);
    const labels = [
      ...new Set(result.items.map((item: unknown) => {
        record(item, `${probe.id}: invalid completion item`);
        assert.equal(typeof item.label, "string", `${probe.id}: invalid completion label`);
        return String(item.label).replace(/\?$/, "");
      })),
    ].sort();
    return { text: labels.join("\n"), labels };
  }
  assert.ok(Array.isArray(result.signatures) && result.signatures.length > 0, `${probe.id}: missing signatures`);
  assert.equal(typeof result.activeParameter, "number", `${probe.id}: missing activeParameter`);
  return {
    text: result.signatures.map((item: unknown) => {
      record(item, `${probe.id}: invalid signature`);
      assert.equal(typeof item.label, "string", `${probe.id}: invalid signature label`);
      return item.label;
    }).join("\n"),
    activeParameter: Number(result.activeParameter),
  };
}

export function validate(probe: Probe, observation: ReturnType<typeof observe>): void {
  assert.ok(observation.text.length > 0, `${probe.id}: empty observation`);
  for (const required of probe.require) {
    assert.ok(
      observation.labels ? observation.labels.includes(required) : observation.text.includes(required),
      `${probe.id}: missing ${required}\n${observation.text}`,
    );
  }
  for (const forbidden of probe.forbid ?? []) {
    assert.ok(!observation.labels?.includes(forbidden), `${probe.id}: unexpected completion ${forbidden}`);
  }
  if (probe.method !== "completion") {
    assert.ok(
      observation.text.length <= (probe.maxLength ?? (probe.method === "hover" ? 400 : 650)),
      `${probe.id}: oversized ${probe.method} (${observation.text.length})`,
    );
    assert.doesNotMatch(
      observation.text,
      /\b(?:any|never|unknown)\b|\.\.\.\s*\d+\s*more|\.\.\.|…/,
      `${probe.id}: degraded or truncated ${probe.method}`,
    );
  }
  if (probe.activeParameter !== undefined) {
    assert.equal(observation.activeParameter, probe.activeParameter, `${probe.id}: active argument`);
  }
}
