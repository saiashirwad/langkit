import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = new URL("..", import.meta.url);
const exports: Record<string, string> = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
).exports;

// Node resolves langkit/parse through package.json exports; Vite needs the same map spelled out.
const alias = Object.entries(exports).map(([path, target]) => ({
  find: new RegExp(`^${path.replace(/^\./, "langkit")}$`),
  replacement: fileURLToPath(new URL(target, root)),
}));

// The editor's TypeScript needs parserator's declarations, and import.meta.glob skips node_modules.
const parserator = new URL("node_modules/parserator/", root);
const typings = {
  name: "parserator-typings",
  resolveId: (id: string) => (id === "virtual:parserator-typings" ? "\0" + id : undefined),
  load: (id: string) => {
    if (id !== "\0virtual:parserator-typings") return undefined;
    const files = [
      "package.json",
      ...readdirSync(new URL("dist", parserator))
        .filter((file) => file.endsWith(".d.ts"))
        .map((file) => `dist/${file}`),
    ];
    const contents = Object.fromEntries(
      files.map((file) => [file, readFileSync(new URL(file, parserator), "utf8")]),
    );
    return `export default ${JSON.stringify(contents)};`;
  },
};

export default defineConfig({
  plugins: [typings],
  resolve: { alias },
  worker: { format: "es" },
  server: { fs: { allow: [fileURLToPath(root)] } },
});
