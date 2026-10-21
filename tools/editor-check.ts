import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { version } from "typescript";
import {
  editorFile,
  observe,
  position,
  type Probe,
  probes,
  record,
  validate,
  validateResponse,
} from "./editor-contracts.ts";
import { compiler, fragment, root } from "./type-contracts.ts";

const args = process.argv.slice(2);
assert.ok(
  args.every((arg) => ["--update", "--inspect"].includes(arg)),
  "usage: editor-check.ts [--update] [--inspect]",
);
const source = readFileSync(join(root, editorFile), "utf8");
const uri = pathToFileURL(join(root, editorFile)).href;
const rootUri = pathToFileURL(root).href;
const snapshotFile = join(root, "tests/editor-consumer.snapshot.json");
for (const probe of probes) position(source, probe);
const child = spawn(process.execPath, [compiler, "--lsp", "--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
const pending = new Map<number, Pending>();
let sequence = 0;
let bytes = Buffer.alloc(0);
let logs = "";
let failed: unknown;
const send = (message: Record<string, unknown>) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const fail = (error: unknown) => {
  failed = error;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
};
const receive = (message: unknown) => {
  validateResponse(message);
  if (typeof message.method === "string") {
    if (message.id !== undefined) {
      let result: unknown = null;
      if (message.method === "workspace/configuration") {
        record(message.params, "invalid configuration params");
        assert.ok(Array.isArray(message.params.items), "invalid configuration items");
        result = message.params.items.map(() => ({}));
      } else if (message.method === "workspace/workspaceFolders") result = [{ uri: rootUri, name: "langkit" }];
      else if (!["client/registerCapability", "window/workDoneProgress/create"].includes(message.method)) {
        send({ id: message.id, error: { code: -32601, message: `Unsupported client request ${message.method}` } });
        return;
      }
      send({ id: message.id, result });
    }
    return;
  }
  assert.equal(typeof message.id, "number", "unexpected string response id");
  const entry = pending.get(Number(message.id));
  assert.ok(entry, `unexpected response ${message.id}`);
  pending.delete(Number(message.id));
  clearTimeout(entry.timer);
  if (Object.hasOwn(message, "error")) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
child.stdout.on("data", (chunk: Buffer) => {
  try {
    bytes = Buffer.concat([bytes, chunk]);
    while (true) {
      const end = bytes.indexOf("\r\n\r\n");
      if (end < 0) break;
      const match = bytes.subarray(0, end).toString().match(/^Content-Length: (\d+)$/im);
      assert.ok(match, "missing Content-Length");
      const length = Number(match[1]);
      assert.ok(length > 0 && length < 16_000_000, "invalid Content-Length");
      if (bytes.length < end + 4 + length) break;
      const message: unknown = JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString());
      bytes = bytes.subarray(end + 4 + length);
      receive(message);
    }
  } catch (error) {
    fail(error);
    child.kill();
  }
});
child.stderr.on("data", (chunk: Buffer) => {
  logs = `${logs}${chunk}`.slice(-8000);
});
child.on("error", fail);
child.stdin.on("error", fail);
child.on("exit", (code, signal) => fail(new Error(`LSP exited ${code ?? signal}\n${logs}`)));
const request = (method: string, params?: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (failed) {
      reject(failed);
      return;
    }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`LSP timeout: ${method}\n${logs}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });

try {
  const initialized = await request("initialize", {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: "langkit" }],
    initializationOptions: { runExternalCode: true },
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      textDocument: {
        hover: { contentFormat: ["markdown"] },
        completion: { completionItem: { snippetSupport: true } },
        signatureHelp: { signatureInformation: { parameterInformation: { labelOffsetSupport: true } } },
      },
    },
  });
  record(initialized, "invalid initialize result");
  record(initialized.serverInfo, "invalid serverInfo");
  record(initialized.capabilities, "invalid capabilities");
  assert.equal(initialized.serverInfo.version, version, "LSP must use installed compiler");
  assert.equal(initialized.capabilities.positionEncoding, "utf-16");
  for (const key of ["hoverProvider", "completionProvider", "signatureHelpProvider", "diagnosticProvider"]) {
    assert.ok(initialized.capabilities[key], `LSP lacks ${key}`);
  }
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: { textDocument: { uri, languageId: "typescript", version: 1, text: source } },
  });
  const diagnostics = await request("textDocument/diagnostic", { textDocument: { uri } });
  record(diagnostics, "invalid diagnostics");
  assert.equal(diagnostics.kind, "full");
  assert.deepEqual(diagnostics.items, [], "editor corpus must compile cleanly");
  const observations: Record<string, ReturnType<typeof observe>> = {};
  for (const probe of probes) {
    const observation = observe(
      probe,
      await request(`textDocument/${probe.method}`, { textDocument: { uri }, position: position(source, probe) }),
    );
    if (args.includes("--inspect")) console.log(`${probe.id}: ${JSON.stringify(observation)}`);
    validate(probe, observation);
    observations[probe.id] = observation;
  }
  const controls = [
    {
      id: "yield-literal",
      original: "pure(\"ready\" as const)",
      replacement: (type: string) => type === "any" ? "pure<any>(\"ready\")" : "pure<never>(undefined as never)",
    },
    {
      id: "judgment-synth-yield",
      original: "judgments.synth({ kind: \"number\", value: 42 })",
      replacement: (type: string) => `pure<${type}>(undefined as ${type})`,
    },
    {
      id: "staged-output",
      original: "staged.prop(stagedProgram.result, \"total\")",
      replacement: (type: string) => `undefined as ${type}`,
    },
  ];
  let documentVersion = 1;
  for (const mutation of controls) {
    const control = probes.find((probe) => probe.id === mutation.id)!;
    const seed = fragment(source, mutation.original);
    for (const type of ["any", "never"]) {
      const mutated = source.slice(0, seed.index) + mutation.replacement(type)
        + source.slice(seed.index + seed.text.length);
      send({
        method: "textDocument/didChange",
        params: { textDocument: { uri, version: ++documentVersion }, contentChanges: [{ text: mutated }] },
      });
      const observation = observe(
        control,
        await request("textDocument/hover", { textDocument: { uri }, position: position(mutated, control) }),
      );
      assert.match(observation.text, new RegExp(`\\b${type}\\b`), `real LSP must observe ${type} mutation`);
      assert.throws(() => validate(control, observation), /missing|degraded/, "mutant hover must fail gate");
      console.log(`Real LSP ${control.id} ${type} control rejected: ${observation.text.replaceAll("\n", " ")}`);
    }
    send({
      method: "textDocument/didChange",
      params: { textDocument: { uri, version: ++documentVersion }, contentChanges: [{ text: source }] },
    });
    assert.deepEqual(
      observe(
        control,
        await request("textDocument/hover", { textDocument: { uri }, position: position(source, control) }),
      ),
      observations[control.id],
      "restored hover must recover",
    );
  }
  const hosted = [
    {
      consumer: "examples/typescript/toy.ts",
      anchor: "import main",
      offset: 7,
      require: ["main: number"],
      guest: "examples/toy/main.toy",
      binder: "let twice",
    },
    {
      consumer: "examples/typescript/advanced.ts",
      anchor: "both, fromList",
      offset: 0,
      require: ["both: (x: <A>(x: A) => A) =>"],
      guest: "examples/advanced/trees.advanced",
      binder: "both = fn",
    },
    {
      consumer: "examples/typescript/hm.ts",
      anchor: "import compose",
      offset: 7,
      require: ["main: <A, B>(x: (x: A) => B) => <C>(x: (x: C) => A) => (x: C) => B"],
      guest: "examples/hm/compose.hm",
      binder: "fn(f)",
    },
    {
      consumer: "examples/typescript/schema.ts",
      anchor: "type User }",
      offset: 5,
      require: ["interface User"],
      guest: "examples/schema/simple.schema",
      binder: "User = {",
    },
    {
      consumer: "examples/typescript/schema.ts",
      anchor: "type Role,",
      offset: 5,
      require: ["type Role = \"Admin\" | \"Member\""],
      guest: "examples/schema/simple.schema",
      binder: "Role = Member",
    },
    {
      consumer: "examples/typescript/blog.ts",
      anchor: "userByEmail({ email: \"sai",
      offset: 0,
      require: [
        "(method) Database.userByEmail(params: {\n    readonly email: string;\n}): User | undefined",
        "SELECT \"t0\".\"id\" AS \"id\"",
        "WHERE \"t0\".\"email\" = :email LIMIT 1",
      ],
      guest: "examples/schema/blog.schema",
      binder: "userByEmail(email",
    },
    {
      consumer: "examples/typescript/blog.ts",
      anchor: "entry.title,",
      offset: 6,
      require: ["title: string"],
      guest: "examples/schema/blog.schema",
      binder: "title,\n      .featured",
    },
  ];
  for (const { consumer, anchor, offset, require, guest, binder } of hosted) {
    const text = readFileSync(join(root, consumer), "utf8");
    const textDocument = { uri: pathToFileURL(join(root, consumer)).href };
    send({
      method: "textDocument/didOpen",
      params: { textDocument: { ...textDocument, languageId: "typescript", version: 1, text } },
    });
    const consumerDiagnostics = await request("textDocument/diagnostic", { textDocument });
    record(consumerDiagnostics, "invalid diagnostics");
    assert.deepEqual(consumerDiagnostics.items, [], `${consumer} must compile cleanly`);
    const probe: Probe = { id: consumer, method: "hover", anchor, offset, require };
    const at = position(text, probe);
    const hover = observe(probe, await request("textDocument/hover", { textDocument, position: at }));
    validate(probe, hover);
    const definitions = await request("textDocument/definition", { textDocument, position: at });
    assert.ok(Array.isArray(definitions), `${consumer}: invalid definition result`);
    const targets = definitions.map((location: unknown) => {
      record(location, `${consumer}: invalid definition location`);
      const range = location.targetSelectionRange ?? location.range;
      record(range, `${consumer}: invalid definition range`);
      return { uri: location.targetUri ?? location.uri, start: range.start };
    });
    const binding: Probe = { id: guest, method: "hover", anchor: binder, offset: 0, require: [] };
    assert.deepEqual(
      targets,
      [{
        uri: pathToFileURL(join(root, guest)).href,
        start: position(readFileSync(join(root, guest), "utf8"), binding),
      }],
      `${consumer}: definition must land on ${binder} in ${guest}`,
    );
    console.log(`Real LSP ${consumer}: hover ${JSON.stringify(hover.text)}, definition on ${binder} in ${guest}`);
  }
  const snapshot = { compilerVersion: version, observations };
  if (args.includes("--update")) writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  else {assert.deepEqual(
      snapshot,
      JSON.parse(readFileSync(snapshotFile, "utf8")),
      "editor output changed: inspect before --update",
    );}
  console.log(`TS ${version} LSP: ${probes.length} probes, clean diagnostics, any/never controls passed`);
  await request("shutdown");
  send({ method: "exit" });
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  fail(new Error("editor check finished"));
}
