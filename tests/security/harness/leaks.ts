import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SECURITY_FIXTURES } from "./paths.js";

export interface PlantedSecret {
  id: string;
  value: string;
}

/** The planted fake secrets (ST-04). */
export function plantedSecrets(): PlantedSecret[] {
  const doc = JSON.parse(readFileSync(join(SECURITY_FIXTURES, "planted-secrets.json"), "utf8")) as {
    secrets: Array<{ id: string; value?: string; parts?: string[] }>;
  };
  return doc.secrets.map((s) => ({ id: s.id, value: s.value ?? (s.parts ?? []).join("") }));
}

export interface Leak {
  secret: string;
  encoding: "raw" | "base64" | "base64url" | "url" | "json";
  where: string;
}

/** Encodings under which a leaked secret is still a leak. */
function variants(value: string): Array<[Leak["encoding"], string]> {
  return [
    ["raw", value],
    ["base64", Buffer.from(value).toString("base64").replace(/=+$/, "")],
    ["base64url", Buffer.from(value).toString("base64url")],
    ["url", encodeURIComponent(value)],
    ["json", JSON.stringify(value).slice(1, -1)],
  ];
}

/** Scans text for every planted secret in every encoding. Reports the secret's id, never its value. */
export function scanText(text: string, where: string, secrets = plantedSecrets()): Leak[] {
  const leaks: Leak[] = [];
  for (const s of secrets) {
    const seen = new Set<string>();
    for (const [encoding, needle] of variants(s.value)) {
      if (needle.length < 8 || seen.has(needle)) continue;
      seen.add(needle);
      if (text.includes(needle)) leaks.push({ secret: s.id, encoding, where });
    }
  }
  return leaks;
}

/** Scans every file under the given roots (outputs, logs, prompt captures, packages, exported audit). */
export function scanFiles(roots: string[], secrets = plantedSecrets()): Leak[] {
  const leaks: Leak[] = [];
  const walk = (dir: string, base: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, base);
      else leaks.push(...scanText(readFileSync(path).toString("latin1"), relative(base, path), secrets));
    }
  };
  for (const root of roots) walk(root, root);
  return leaks;
}
