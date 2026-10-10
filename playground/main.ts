import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { connect } from "./client.ts";
import { names, type Name, type Setup } from "./languages.ts";
import type { Output, Run } from "./runner.ts";
import parseratorTypings from "virtual:parserator-typings";
import "./style.css";

self.MonacoEnvironment = {
  getWorker: (_, label) =>
    label === "typescript" || label === "javascript" ? new TypeScriptWorker() : new EditorWorker(),
};

const uriOf = (path: string): string => path.replace(/^\.\.\//, "file:///");

// Every example file except the Node entry points, keyed by URI.
const examples: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(
      [
        "../examples/*/*",
        "../examples/modules.ts",
        "!../examples/*/*-run.ts",
        "!../examples/*/*-lsp.ts",
      ],
      { query: "?raw", import: "default", eager: true },
    ),
  ).map(([path, text]) => [uriOf(path), text]),
);

// Types for edited languages: langkit's own sources and parserator's declarations.
const langkit = import.meta.glob<string>(["../package.json", "../src/*.ts", "!../src/lsp.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});
for (const [path, text] of Object.entries(langkit))
  monaco.typescript.typescriptDefaults.addExtraLib(
    text,
    path.replace(/^\.\.\//, "file:///node_modules/langkit/"),
  );
for (const [path, text] of Object.entries(parseratorTypings))
  monaco.typescript.typescriptDefaults.addExtraLib(text, `file:///node_modules/parserator/${path}`);
// Sources import each other, so TypeScript needs every model, not just the open one.
monaco.typescript.typescriptDefaults.setEagerModelSync(true);
monaco.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.typescript.ScriptTarget.ESNext,
  module: monaco.typescript.ModuleKind.ESNext,
  // Bundler resolution reads package.json exports, like Node does for langkit/parse.
  moduleResolution: 100 as monaco.typescript.ModuleResolutionKind,
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
});

for (const name of names) monaco.languages.register({ id: name, extensions: [`.${name}`] });

const theme = (base: "vs" | "vs-dark", colors: Record<string, string>) => ({
  base,
  inherit: true,
  rules: Object.entries(colors).map(([token, foreground]) => ({ token, foreground })),
  colors: {},
});
monaco.editor.defineTheme(
  "langkit-light",
  theme("vs", {
    keyword: "8a3ffc",
    type: "007d79",
    function: "0f62fe",
    parameter: "b28600",
    variable: "262626",
    number: "198038",
    string: "a2191f",
    operator: "6f6f6f",
  }),
);
monaco.editor.defineTheme(
  "langkit-dark",
  theme("vs-dark", {
    keyword: "be95ff",
    type: "3ddbd9",
    function: "78a9ff",
    parameter: "f1c21b",
    variable: "e0e0e0",
    number: "6fdc8c",
    string: "ff8389",
    operator: "a8a8a8",
  }),
);
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => monaco.editor.setTheme(dark.matches ? "langkit-dark" : "langkit-light");
dark.addEventListener("change", applyTheme);
applyTheme();

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const languageSelect = element<HTMLSelectElement>("language");
const editingBox = element<HTMLInputElement>("editing");
const tabs = element<HTMLElement>("tabs");
const status = element<HTMLElement>("status");
const output = element<HTMLElement>("output");

const hash = location.hash.slice(1);
let name: Name = names.find((candidate) => candidate === hash) ?? "toy";
let editing = false;

const inFolder = (uri: string): boolean => uri.startsWith(`file:///examples/${name}/`);

/** The program files: the main file first, as the CLI runs it by default. */
const programs = (): string[] =>
  Object.keys(examples)
    .filter((uri) => inFolder(uri) && !uri.endsWith(".ts"))
    .sort(
      (a, b) => Number(b.includes("/main.")) - Number(a.includes("/main.")) || a.localeCompare(b),
    );

/** The language's TypeScript, plus the shared module loader when it is imported. */
const sources = (): string[] => {
  const own = Object.keys(examples).filter((uri) => inFolder(uri) && uri.endsWith(".ts"));
  return own.some((uri) => examples[uri]!.includes('"../modules.ts"'))
    ? [...own, "file:///examples/modules.ts"]
    : own;
};

const visible = (): string[] => [...programs(), ...(editing ? sources() : [])];

const model = (uri: string): monaco.editor.ITextModel => {
  const parsed = monaco.Uri.parse(uri);
  const language = uri.endsWith(".ts") ? "typescript" : uri.split("/").at(-2)!;
  return (
    monaco.editor.getModel(parsed) ??
    monaco.editor.createModel(examples[uri] ?? "", language, parsed)
  );
};

const snapshot = (uris: readonly string[]): Record<string, string> =>
  Object.fromEntries(uris.map((uri) => [uri, model(uri).getValue()]));

const setup = (): Setup => ({
  name,
  files: snapshot(programs()),
  ...(editing ? { sources: snapshot(sources()) } : {}),
});

const editor = monaco.editor.create(element("editor"), {
  model: model(programs()[0]!),
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 14,
  scrollBeyondLastLine: false,
  "semanticHighlighting.enabled": true,
});

const views = new Map<string, monaco.editor.ICodeEditorViewState | null>();
let current = programs()[0]!;

const renderTabs = (): void => {
  const program = new Set(programs());
  tabs.replaceChildren(
    ...visible().map((uri) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.textContent = uri.split("/").at(-1)!;
      if (!program.has(uri)) tab.className = "source";
      tab.setAttribute("aria-current", String(uri === current));
      tab.addEventListener("click", () => open(uri));
      return tab;
    }),
  );
};

const open = (uri: string): void => {
  views.set(current, editor.saveViewState());
  current = uri;
  editor.setModel(model(uri));
  const view = views.get(uri);
  if (view) editor.restoreViewState(view);
  editor.focus();
  renderTabs();
};

// Definitions in another file switch tabs; Monaco alone only navigates within one model.
monaco.editor.registerEditorOpener({
  openCodeEditor: (_, resource, selection) => {
    const uri = resource.toString();
    if (!visible().includes(uri)) return false;
    open(uri);
    if (selection && "startLineNumber" in selection) {
      editor.setSelection(selection);
      editor.revealRangeInCenter(selection);
    } else if (selection) {
      editor.setPosition(selection);
      editor.revealPositionInCenter(selection);
    }
    return true;
  },
});

let server: { readonly worker: Worker; connection?: monaco.IDisposable } | undefined;

/** Start a language server for the current language, replacing the previous one. */
const restart = async (): Promise<void> => {
  server?.connection?.dispose();
  server?.worker.terminate();
  const worker = new Worker(new URL("./server.ts", import.meta.url), { type: "module" });
  const started: { readonly worker: Worker; connection?: monaco.IDisposable } = { worker };
  server = started;
  const reply = new Promise<{ ready?: true; error?: string }>((resolve) => {
    worker.addEventListener("message", ({ data }) => resolve(data), { once: true });
    worker.addEventListener("error", (event) => resolve({ error: event.message }), { once: true });
  });
  worker.postMessage(setup());
  const { error } = await reply;
  if (server !== started) return;
  status.textContent = error === undefined ? "" : `The language failed to load:\n${error}`;
  if (error === undefined) started.connection = connect(worker, name);
};

let pending: ReturnType<typeof setTimeout> | undefined;
monaco.editor.onDidCreateModel((created) => {
  if (created.getLanguageId() !== "typescript") return;
  created.onDidChangeContent(() => {
    if (!editing || !sources().includes(created.uri.toString())) return;
    clearTimeout(pending);
    pending = setTimeout(() => void restart(), 400);
  });
});

const write = ({ kind, text }: Output): void => {
  const line = document.createElement("span");
  line.className = kind;
  line.textContent = `${text}\n`;
  output.append(line);
};

let running: Worker | undefined;

const run = (): void => {
  running?.terminate();
  output.replaceChildren();
  const uri = programs().includes(current) ? current : programs()[0]!;
  const worker = new Worker(new URL("./runner.ts", import.meta.url), { type: "module" });
  running = worker;
  const stop = setTimeout(() => {
    worker.terminate();
    write({ kind: "error", text: "Stopped after 3 seconds." });
  }, 3000);
  worker.onmessage = ({ data }: MessageEvent<Output>) => {
    if (data.kind !== "done") return write(data);
    clearTimeout(stop);
    worker.terminate();
  };
  worker.onerror = (event) => {
    clearTimeout(stop);
    write({ kind: "error", text: event.message });
  };
  worker.postMessage({ ...setup(), uri } satisfies Run);
};

const choose = (next: Name): void => {
  name = next;
  history.replaceState(null, "", `#${name}`);
  output.replaceChildren();
  open(programs()[0]!);
  void restart();
};

languageSelect.append(
  ...names.map((option) => {
    const item = document.createElement("option");
    item.value = item.textContent = option;
    return item;
  }),
);
languageSelect.value = name;
languageSelect.addEventListener("change", () => choose(languageSelect.value as Name));

editingBox.addEventListener("change", () => {
  editing = editingBox.checked;
  // TypeScript only sees open models, so every source exists before any is shown.
  if (editing) for (const uri of sources()) model(uri);
  if (!visible().includes(current)) open(programs()[0]!);
  else renderTabs();
  void restart();
});

element("run").addEventListener("click", run);
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

renderTabs();
void restart();
