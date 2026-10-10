import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { render } from "langkit";
import { compile } from "./ur.ts";

const file = process.argv[2] ?? new URL("./main.ur", import.meta.url);
try {
  const source = readFileSync(file, "utf8"),
    result = compile(source);
  if (!result.success) {
    console.error(render(result.error, source));
    process.exitCode = 1;
  } else {
    const value = runInNewContext(
      result.value.javascript,
      { console: { log: (...values: unknown[]) => console.log(...values) } },
      { timeout: 1000 },
    );
    if (result.value.entry === "value") console.log(value);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
