import { readFile } from "node:fs/promises";
import ts from "typescript";

// Node executes the real TS source without writing build artifacts or installing a runner.
// Browser-only environment values are empty; API tests stub fetch explicitly.
export async function loadTestModule(sourceUrl) {
  const moduleUrls = new Map();

  async function compile(url) {
    if (moduleUrls.has(url.href)) return moduleUrls.get(url.href);
    const source = await readFile(url, "utf8");
    let { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    });
    outputText = outputText.replaceAll("import.meta.env", "({})");
    const imports = [...outputText.matchAll(/from\s+["'](\.[^"']+)["']/g)];
    for (const match of imports) {
      const importUrl = new URL(`${match[1]}.ts`, url);
      const compiledUrl = await compile(importUrl);
      outputText = outputText.replace(match[0], `from ${JSON.stringify(compiledUrl)}`);
    }
    const compiled = `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
    moduleUrls.set(url.href, compiled);
    return compiled;
  }

  return import(await compile(sourceUrl));
}
