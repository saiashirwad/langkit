import { transform } from "sucrase";
import * as parserator from "parserator";
import * as langkit from "langkit";
import * as parse from "langkit/parse";
import * as ir from "langkit/ir";
import * as javascript from "langkit/javascript";
import * as analysis from "langkit/analysis";

const packages: Record<string, unknown> = {
  parserator,
  langkit,
  "langkit/parse": parse,
  "langkit/ir": ir,
  "langkit/javascript": javascript,
  "langkit/analysis": analysis,
};

/**
 * Evaluate edited TypeScript sources, starting at entry. Types are stripped and
 * imports become require calls: packages resolve to the bundled langkit, and
 * relative paths resolve among the sources. This trusts the sources completely.
 */
export const evaluate = (sources: ReadonlyMap<string, string>, entry: string): unknown => {
  const loaded = new Map<string, { exports: unknown }>();

  const load = (uri: string): unknown => {
    const cached = loaded.get(uri);
    if (cached) return cached.exports;
    const source = sources.get(uri);
    if (source === undefined) throw new Error(`No module ${uri}`);
    const module = { exports: {} };
    loaded.set(uri, module);
    // Keep ?? and ?. as written: sucrase's rewrite wraps them in arrows, which breaks yield*.
    const { code } = transform(source, {
      transforms: ["typescript", "imports"],
      disableESTransforms: true,
      filePath: uri,
    });
    const require = (specifier: string): unknown => {
      if (specifier in packages) return packages[specifier];
      if (!specifier.startsWith("./") && !specifier.startsWith("../"))
        throw new Error(`Unknown package ${JSON.stringify(specifier)} in ${uri}`);
      return load(new URL(specifier, uri).href);
    };
    new Function("require", "module", "exports", code)(require, module, module.exports);
    return module.exports;
  };

  return load(entry);
};
