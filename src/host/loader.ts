import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { type Diagnostic, render, site } from "../diagnostic.ts";
import { hostFor, type HostLanguage } from "../host.ts";

const describe = (diagnostic: Diagnostic, url: string, source: string): string => {
  const location = site(diagnostic, url);
  if (location && location.uri !== url) return `${location.uri}: ${render(diagnostic)}`;
  return `${fileURLToPath(url)}: ${render(location ? { ...diagnostic, span: location.span } : diagnostic, source)}`;
};

export const registerHostLanguages = (languages: readonly HostLanguage[]): void => {
  const language = hostFor(languages);
  registerHooks({
    load(url, context, nextLoad) {
      const host = url.startsWith("file:") ? language(fileURLToPath(url)) : undefined;
      if (!host) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), "utf8");
      const hosted = host.host(source, url);
      if (hosted.javascript === undefined || hosted.diagnostics.length > 0) {
        throw new SyntaxError(hosted.diagnostics.map((diagnostic) => describe(diagnostic, url, source)).join("\n"));
      }
      return { format: "module", source: hosted.javascript(), shortCircuit: true };
    },
  });
};
