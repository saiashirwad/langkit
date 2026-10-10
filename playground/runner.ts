import { render } from "langkit";
import { load, reader, type Language, type Setup } from "./languages.ts";

export type Run = Setup & { readonly uri: string };

export type Output = { readonly kind: "log" | "error" | "done"; readonly text: string };

/** The fields the example languages' compile results share. */
type Compiled = {
  readonly type?: unknown;
  readonly javascript?: string;
  readonly sql?: string;
  readonly entry?: string;
};

const scope = self as unknown as Worker;

const post = (kind: Output["kind"], text = ""): void => scope.postMessage({ kind, text });

/** Close to Node's console.log formatting: strings are quoted only inside values. */
const inspect = (value: unknown, depth = 0): string => {
  if (typeof value === "string") return depth ? `'${value.replaceAll("'", "\\'")}'` : value;
  if (typeof value === "function")
    return `[Function${value.name ? `: ${value.name}` : " (anonymous)"}]`;
  if (Object.is(value, -0)) return "-0";
  if (typeof value !== "object" || value === null) return String(value);
  if (depth > 2) return Array.isArray(value) ? "[Array]" : "[Object]";
  const parts = Array.isArray(value)
    ? value.map((item) => inspect(item, depth + 1))
    : Object.entries(value).map(
        ([key, item]) =>
          `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`}: ${inspect(item, depth + 1)}`,
      );
  if (!parts.length) return Array.isArray(value) ? "[]" : "{}";
  return Array.isArray(value) ? `[ ${parts.join(", ")} ]` : `{ ${parts.join(", ")} }`;
};

const console = {
  log: (...values: unknown[]) => post("log", values.map((value) => inspect(value)).join(" ")),
};

/** The CLI runners' behavior: schema prints SQL, effects run once, statement entries print nothing. */
const execute = (language: Language, compiled: Compiled): void => {
  if (typeof compiled.sql === "string") return post("log", compiled.sql);
  if (typeof compiled.javascript !== "string")
    return post("error", "compile returned neither javascript nor sql");
  const effect = compiled.type !== undefined && /^Effect\b/.test(language.show(compiled.type));
  const value = new Function("console", `return (${compiled.javascript})${effect ? "({})" : ""};`)(
    console,
  );
  if (!effect && (compiled.entry ?? "value") === "value") console.log(value);
};

scope.onmessage = async ({ data }: MessageEvent<Run>) => {
  try {
    const language = await load(data);
    const source = data.files[data.uri] ?? "";
    const result = language.compile(source, { uri: data.uri, read: reader(data.files) });
    if (result.success) execute(language, result.value as Compiled);
    else post("error", render(result.error, source));
  } catch (error) {
    post("error", error instanceof Error ? error.message : String(error));
  }
  post("done");
};
