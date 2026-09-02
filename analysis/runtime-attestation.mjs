import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export async function sourceRuntimeAttestation(repoRoot) {
  const backgroundPath = path.join(repoRoot, "extension/command-center-background.js");
  const source = await readFile(backgroundPath, "utf8");
  const context = { Date, TextEncoder, URL };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  const helpers = context.SKRODZKaiCommandCenterBackground;
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "manifest.json"), "utf8"));
  const digest = await helpers.runtimeDigest(
    { runtime:{ getURL:(runtimePath) => runtimePath } },
    (runtimePath) => readFile(path.join(repoRoot, runtimePath)),
    webcrypto,
    TextEncoder,
  );
  return { version:String(manifest.version), digest, files:[...helpers.RUNTIME_FILES] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  process.stdout.write(`${JSON.stringify(await sourceRuntimeAttestation(repoRoot), null, 2)}\n`);
}
