import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturesRoot = fileURLToPath(new URL("../../../fixtures/contract/", import.meta.url));
export const validDocsDir = join(fixturesRoot, "valid");
export const validPackagesDir = join(fixturesRoot, "packages/valid");
export const invalidDir = join(fixturesRoot, "invalid");

export type Json = Record<string, unknown>;

/** Reads a directory into the PackageInput shape (POSIX paths → bytes). */
export function readPackage(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(dir, p).split("\\").join("/"), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return files;
}

export const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;
export const validDoc = (name: string): Json => readJson(join(validDocsDir, `${name}.json`));
export const packageDoc = (pkg: string, file: string): Json => readJson(join(validPackagesDir, pkg, file));

/** Replaces one file of a package with JSON (no checksum update, so only use for pre-checksum stages). */
export function withJson(files: Map<string, Uint8Array>, path: string, value: unknown): Map<string, Uint8Array> {
  const copy = new Map(files);
  copy.set(path, new TextEncoder().encode(JSON.stringify(value)));
  return copy;
}
