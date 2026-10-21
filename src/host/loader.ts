import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Diagnostic, render } from "../diagnostic.ts";
import type { HostLanguage } from "../host.ts";
import { place } from "./place.ts";

const describe = (diagnostic: Diagnostic, url: string, source: string): string => {
  const site = place(diagnostic, url);
  if (site.kind === "elsewhere") return `${site.location.uri}: ${render(diagnostic)}`;
  const file = fileURLToPath(url);
  return site.span
    ? `${file}: ${render({ ...diagnostic, span: site.span }, source)}`
    : `${file}: ${render(diagnostic)}`;
};

export const registerHostLanguages = (languages: readonly HostLanguage[]): void => {
  const registry = new Map<string, HostLanguage>(languages.map((language) => [language.extension, language]));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!registry.has(extname(specifier)) || context.parentURL === undefined) return nextResolve(specifier, context);
      return { url: new URL(specifier, context.parentURL).href, format: "module", shortCircuit: true };
    },
    load(url, context, nextLoad) {
      const language = url.startsWith("file:") ? registry.get(extname(fileURLToPath(url))) : undefined;
      if (!language) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), "utf8");
      const hosted = language.host(source, url);
      if (hosted.javascript === undefined || hosted.diagnostics.length > 0) {
        throw new SyntaxError(hosted.diagnostics.map((diagnostic) => describe(diagnostic, url, source)).join("\n"));
      }
      return { format: "module", source: hosted.javascript, shortCircuit: true };
    },
  });
};
