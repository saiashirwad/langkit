import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluate } from "../playground/custom.ts";
import { entry, load, names, reader, type Language } from "../playground/languages.ts";

const examples = new URL("../examples/", import.meta.url);

/** One language folder, keyed by the playground's URIs, without the Node entry points. */
const folder = (name: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(new URL(`${name}/`, examples))
      .filter((file) => !file.endsWith("-run.ts") && !file.endsWith("-lsp.ts"))
      .map((file) => [
        `file:///examples/${name}/${file}`,
        readFileSync(new URL(`${name}/${file}`, examples), "utf8"),
      ]),
  );

for (const name of names) {
  test(`playground evaluates edited ${name} sources like the ${name} module`, async () => {
    const files = folder(name);
    const sources = new Map(Object.entries(files).filter(([uri]) => uri.endsWith(".ts")));
    sources.set(
      "file:///examples/modules.ts",
      readFileSync(new URL("modules.ts", examples), "utf8"),
    );
    const edited = evaluate(sources, entry(name)) as Language;
    const original = await load({ name, files });
    const uri = `file:///examples/${name}/main.${name}`;
    const options = { uri, read: reader(files) };
    const compiled = edited.compile(files[uri]!, options);
    const expected = original.compile(files[uri]!, options);
    assert.ok(compiled.success && expected.success);
    const { javascript, sql } = compiled.value as { javascript?: string; sql?: string };
    const reference = expected.value as { javascript?: string; sql?: string };
    assert.equal(javascript, reference.javascript);
    assert.equal(sql, reference.sql);
    assert.deepEqual(edited.analyze(files[uri]!, options).diagnostics, []);
  });
}

test("playground evaluation reports unknown packages and missing modules", () => {
  const sources = new Map([
    ["file:///a.ts", 'import { x } from "left-pad"; export const y = x;'],
    ["file:///b.ts", 'export { x } from "./missing.ts";'],
  ]);
  assert.throws(() => evaluate(sources, "file:///a.ts"), /Unknown package "left-pad"/);
  assert.throws(() => evaluate(sources, "file:///b.ts"), /No module file:\/\/\/missing\.ts/);
});
