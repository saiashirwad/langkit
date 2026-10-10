import { readFileSync } from "node:fs";
import { render } from "langkit";
import { compile } from "./schema.ts";

const source = readFileSync(process.argv[2] ?? new URL("./main.schema", import.meta.url), "utf8");
const result = compile(source);
if (result.success) process.stdout.write(result.value.sql);
else {
  console.error(render(result.error, source));
  process.exitCode = 1;
}
