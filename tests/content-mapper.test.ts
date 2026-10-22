import { project } from "langkit/host";
import { serveContentMapper } from "langkit/host/content-mapper";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { host as advanced } from "../examples/advanced/advanced-host.ts";
import { host as toy } from "../examples/toy/toy-host.ts";

const mapper = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveContentMapper([toy], { input, output });
  let id = 0;
  let pending = "";
  const waiting = new Map<number, (result: unknown) => void>();
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    for (let end = pending.indexOf("\r\n\r\n"); end >= 0; end = pending.indexOf("\r\n\r\n")) {
      const length = Number(/Content-Length: (\d+)/.exec(pending.slice(0, end))![1]);
      const message = JSON.parse(pending.slice(end + 4, end + 4 + length));
      pending = pending.slice(end + 4 + length);
      waiting.get(message.id)?.(message.result);
    }
  });
  return (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
};

test("openProject watches guest files and changes identity when one changes", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "langkit-mapper-")));
  try {
    const guest = join(directory, "src", "main.toy");
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, "node_modules"));
    mkdirSync(join(directory, ".hidden"));
    writeFileSync(guest, "1");
    writeFileSync(join(directory, "node_modules", "dep.toy"), "2");
    writeFileSync(join(directory, ".hidden", "skip.toy"), "3");
    writeFileSync(join(directory, "notes.txt"), "4");
    const request = mapper();
    const configFileName = join(directory, "tsconfig.json");

    const before = await request("openProject", { configFileName });
    assert.deepEqual(before.watchedFiles, [guest]);
    writeFileSync(guest, "2");
    const after = await request("openProject", { configFileName });
    assert.notEqual(after.configIdentity, before.configIdentity);

    const inferred = await request("openProject", {});
    assert.deepEqual(inferred.watchedFiles, []);
    assert.equal(typeof inferred.configIdentity, "string");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("advanced projects each used import with a check against the dependency's type", () => {
  const url = new URL("../examples/advanced/main.advanced", import.meta.url);
  const { text } = project(advanced.host(readFileSync(url, "utf8"), pathToFileURL(url.pathname).href).declarations);
  assert.match(text, /^import \{ mapList \} from "\.\/stdlib\.advanced";$/m);
  assert.match(text, /^mapList satisfies .+;$/m);
});
