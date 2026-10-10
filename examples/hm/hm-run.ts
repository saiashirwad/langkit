import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { render } from "langkit";
import { compile } from "./hm.ts";

const file = process.argv[2] ?? new URL("./main.hm", import.meta.url);
const source = readFileSync(file, "utf8");
const result = compile(source);
if (!result.success) {
  console.error(render(result.error, source));
  process.exitCode = 1;
} else {
  console.log(runInNewContext(result.value.javascript, {}, { timeout: 1000 }));
}
