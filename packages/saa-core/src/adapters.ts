import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  AdapterError,
  AdapterProcess,
  builtinAdapters,
  formatSupportMatrix,
  supportLookup,
  type AdapterSpec,
  type InitializeResult,
} from "@sys2qa/saa-adapters";
import type { SupportLookup } from "./stack/stack.js";

export interface AdapterInventory {
  adapters: InitializeResult[];
  failures: Array<{ id: string; code: string; message: string }>;
}

/**
 * Starts each installed adapter just long enough to read its declared support matrix (SAA-FR-047). Adapters run
 * confined as in an analysis, against an empty root; one that cannot start is listed as unavailable, not hidden.
 */
export async function describeAdapters(
  workDirectory: string,
  specs: ReadonlyArray<AdapterSpec & { built?: boolean }> = builtinAdapters(),
): Promise<AdapterInventory> {
  const inventory: AdapterInventory = { adapters: [], failures: [] };
  if (specs.length === 0) return inventory;
  mkdirSync(workDirectory, { recursive: true });
  const base = mkdtempSync(join(workDirectory, "adapters-"));
  try {
    const root = join(base, "root");
    const scratch = join(base, "scratch");
    mkdirSync(root);
    mkdirSync(scratch);
    for (const spec of specs) {
      if (spec.built === false) {
        inventory.failures.push({
          id: spec.id,
          code: "ADAPTER_NOT_BUILT",
          message: "the adapter bundle is missing; run `pnpm build:adapters`",
        });
        continue;
      }
      try {
        const adapter = await AdapterProcess.start(spec, { root, scratch });
        inventory.adapters.push(adapter.info);
        await adapter.close();
      } catch (error) {
        if (!(error instanceof AdapterError)) throw error;
        inventory.failures.push({ id: spec.id, code: error.code, message: error.message });
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  return inventory;
}

/** Support levels for the stack report from what the adapters declare (IMP-104 → IMP-105). */
export function supportFromAdapters(inventory: AdapterInventory): SupportLookup {
  return supportLookup(inventory.adapters);
}

export function adapterMatrixText(inventory: AdapterInventory): string {
  return formatSupportMatrix(inventory.adapters, inventory.failures);
}
