import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { TextDocument } from "vscode-languageserver-textdocument"
import { encodeTokens } from "langkit/lsp"
import { tokenKinds } from "langkit/analysis"

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }
type Diagnostics = { uri: string; version?: number; diagnostics: { message: string; range: unknown }[] }
type Hover = { contents: { kind: string; value: string }; range: unknown } | null

const client = (t: TestContext, args = [fileURLToPath(new URL("../examples/toy-lsp.ts", import.meta.url)), "--stdio"]) => {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["pipe", "pipe", "pipe"]
  })
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const notifications: Message[] = []
  let wake: (() => void) | undefined
  let buffer = Buffer.alloc(0)
  let id = 0
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const split = buffer.indexOf("\r\n\r\n")
      if (split < 0) return
      const header = buffer.subarray(0, split).toString()
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1])
      assert.ok(Number.isFinite(length), `Invalid LSP header: ${header}`)
      if (buffer.length < split + 4 + length) return
      // Messages are JSON-RPC frames from the subprocess under test.
      const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString()) as Message
      buffer = buffer.subarray(split + 4 + length)
      if (message.id !== undefined) {
        const request = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) request?.reject(new Error(JSON.stringify(message.error)))
        else request?.resolve(message.result)
      } else {
        notifications.push(message)
        wake?.()
      }
    }
  })
  child.on("error", error => {
    for (const request of pending.values()) request.reject(error)
  })
  child.on("exit", code => {
    for (const request of pending.values()) request.reject(new Error(`Server exited ${code}: ${stderr}`))
    wake?.()
  })
  t.after(() => { child.kill() })

  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message })
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  const request = <T = unknown>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
    const current = ++id
    const timer = setTimeout(() => {
      pending.delete(current)
      reject(new Error(`Timed out waiting for ${method}: ${stderr}`))
    }, 3000)
    pending.set(current, {
      // The caller supplies the expected protocol result shape.
      resolve: value => { clearTimeout(timer); resolve(value as T) },
      reject: error => { clearTimeout(timer); reject(error) }
    })
    send({ id: current, method, params })
  })
  const notification = async <T>(method: string, matches: (value: T) => boolean): Promise<T> => {
    const deadline = Date.now() + 3000
    while (true) {
      const index = notifications.findIndex(message => message.method === method && matches(message.params as T))
      if (index >= 0) return notifications.splice(index, 1)[0]!.params as T
      if (child.exitCode !== null) throw new Error(`Server exited: ${stderr}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`Timed out waiting for ${method}: ${stderr}`)
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, remaining)
        wake = () => { clearTimeout(timer); resolve() }
      })
      wake = undefined
    }
  }
  return {
    request,
    notify: (method: string, params: unknown) => send({ method, params }),
    diagnostics: (version?: number) => notification<Diagnostics>("textDocument/publishDiagnostics", value => value.version === version),
    shutdown: async () => {
      await request("shutdown", null)
      const exited = once(child, "exit")
      send({ method: "exit" })
      const timeout = setTimeout(() => child.kill(), 3000)
      try { assert.equal((await exited)[0], 0, stderr) } finally { clearTimeout(timeout) }
    }
  }
}

const uri = "file:///workspace/main.toy"
const position = (source: string, offset: number) => TextDocument.create(uri, "toy", 1, source).positionAt(offset)
const at = (source: string, offset: number) => ({ textDocument: { uri }, position: position(source, offset) })

test("stdio LSP: initialize, analyze, edit, clear and shut down", { timeout: 15000 }, async t => {
  const server = client(t)
  const initialized = await server.request<{ capabilities: { positionEncoding: string; semanticTokensProvider: { legend: { tokenTypes: string[] } } } }>("initialize", {
    processId: null, rootUri: null, capabilities: {}
  })
  assert.equal(initialized.capabilities.positionEncoding, "utf-16")
  assert.deepEqual(initialized.capabilities.semanticTokensProvider.legend.tokenTypes, tokenKinds)
  server.notify("initialized", {})
  let source = "let id = fn(x: number) => x in\r\nid(42)"
  server.notify("textDocument/didOpen", { textDocument: { uri, languageId: "toy", version: 1, text: source } })
  assert.deepEqual((await server.diagnostics(1)).diagnostics, [])

  const hover = await server.request<Hover>("textDocument/hover", at(source, source.lastIndexOf("id")))
  assert.equal(hover?.contents.kind, "plaintext")
  assert.equal(hover?.contents.value, "(number -> number)")
  const definition = await server.request("textDocument/definition", at(source, source.lastIndexOf("id")))
  assert.deepEqual(definition, { uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 6 } } })
  const tokens = await server.request<{ data: number[] }>("textDocument/semanticTokens/full", { textDocument: { uri } })
  assert.ok(tokens.data.length > 0)
  assert.equal(tokens.data.length % 5, 0)
  assert.deepEqual(tokens.data.slice(0, 5), [0, 0, 3, tokenKinds.indexOf("keyword"), 0])
  assert.ok(tokens.data.some((value, index) => index % 5 === 3 && value === tokenKinds.indexOf("function")))

  source = "let x = true in x + 1"
  server.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: source }] })
  const errors = (await server.diagnostics(2)).diagnostics
  assert.equal(errors.length, 1)
  assert.match(errors[0]!.message, /Expected number, found boolean/)
  assert.equal((await server.request<Hover>("textDocument/hover", at(source, source.indexOf("true"))))?.contents.value, "boolean")

  server.notify("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ range: { start: { line: 0, character: 8 }, end: { line: 0, character: 12 } }, text: "41" }]
  })
  assert.deepEqual((await server.diagnostics(3)).diagnostics, [])
  source = "let x = 41 in x + 1"
  assert.equal((await server.request<Hover>("textDocument/hover", at(source, source.indexOf("41"))))?.contents.value, "number")

  source = "let f = fn(x: number) => x +"
  server.notify("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ text: source }] })
  assert.ok((await server.diagnostics(4)).diagnostics.length > 0)
  assert.equal(await server.request("textDocument/definition", at(source, 4)), null)
  assert.equal(await server.request("textDocument/hover", at(source, 4)), null)
  assert.ok((await server.request<{ data: number[] }>("textDocument/semanticTokens/full", { textDocument: { uri } })).data.length > 0)

  server.notify("textDocument/didClose", { textDocument: { uri } })
  assert.deepEqual((await server.diagnostics()).diagnostics, [])
  assert.equal(await server.request("textDocument/hover", at(source, 4)), null)
  assert.equal(await server.request("textDocument/definition", at(source, 4)), null)
  assert.deepEqual(await server.request("textDocument/semanticTokens/full", { textDocument: { uri } }), { data: [] })
  await server.shutdown()
})

test("analyzer exceptions discard old facts without breaking the connection", { timeout: 10000 }, async t => {
  const source = `import { serve } from "langkit/lsp";
serve(text => {
  if (text === "bad") throw new Error("broken analyzer");
  return { diagnostics: [], definitions: [], references: [], tokens: [], types: [{ span: { start: 0, end: text.length }, type: "number" }] };
}, type => type);`
  const server = client(t, ["--input-type=module", "--eval", source])
  await server.request("initialize", { processId: null, capabilities: {} })
  server.notify("initialized", {})
  server.notify("textDocument/didOpen", { textDocument: { uri, languageId: "toy", version: 1, text: "good" } })
  assert.deepEqual((await server.diagnostics(1)).diagnostics, [])
  assert.equal((await server.request<Hover>("textDocument/hover", at("good", 0)))?.contents.value, "number")
  server.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: "bad" }] })
  assert.match((await server.diagnostics(2)).diagnostics[0]!.message, /Internal analysis error/)
  assert.equal(await server.request("textDocument/hover", at("bad", 0)), null)
  await server.shutdown()
})

test("semantic tokens sort, split CRLF lines and count astral characters as UTF-16", () => {
  const document = TextDocument.create(uri, "toy", 1, "😀x\r\ny\nz")
  assert.deepEqual(encodeTokens(document, [
    { kind: "number", span: { start: 7, end: 8 } },
    { kind: "variable", span: { start: 0, end: 6 } }
  ]), [0, 0, 3, 3, 0, 1, 0, 1, 3, 0, 1, 0, 1, 1, 0])
})
