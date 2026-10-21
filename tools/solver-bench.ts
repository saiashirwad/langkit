import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { checkSource } from "../examples/advanced/advanced.ts";

const directory = new URL("../examples/advanced/", import.meta.url);

const synthetic = (size: number): string => {
  const lines = [
    `import "./stdlib.advanced";`,
    `let both = fn(f: forall a. a -> a) => { value = f(20), flag = f(true) } in`,
    `let acc0 = 0 in`,
  ];
  for (let i = 1; i <= size; i++) {
    lines.push(
      `let r${i} = { x${i} = ${i}, flag = true | { a = ${i}, b = "s" } } in`,
      `let pick${i} = fn(r) => r.a + r.x${i} in`,
      `let w${i} = both(fn(x) => x) in`,
      `let n${i} = pick${i}(r${i}) + w${i}.value + length(mapList(fn(n) => n + ${i})(range(0)(3))) in`,
      `let acc${i} = acc${i - 1} + n${i} in`,
    );
  }
  lines.push(`acc${size}`);
  return lines.join("\n");
};

const workloads = [
  { name: "main", source: readFileSync(new URL("main.advanced", directory), "utf8"), iterations: 200 },
  { name: "synthetic-100", source: synthetic(100), iterations: 20 },
  { name: "synthetic-200", source: synthetic(200), iterations: 10 },
  { name: "synthetic-50", source: synthetic(50), iterations: 40 },
];

const uri = new URL("bench.advanced", directory).href;
const selected = process.argv[2];
for (const { name, source, iterations } of workloads) {
  if (selected && name !== selected) continue;
  const once = () => {
    const result = checkSource(source, { uri });
    assert.ok(result.success, `${name} failed: ${JSON.stringify(!result.success && result.errors[0])}`);
    return result.value.type;
  };
  for (let i = 0; i < Math.max(3, iterations / 4); i++) once();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) once();
  const ms = (performance.now() - start) / iterations;
  console.log(JSON.stringify({ name, ms: Number(ms.toFixed(3)), iterations }));
}
