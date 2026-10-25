// Feature switches are loaded at run time from /config.json, which is deployed per environment.
export interface RuntimeConfig {
  loyaltyProgram: boolean;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const res = await fetch("/config.json");
  return res.ok ? ((await res.json()) as RuntimeConfig) : { loyaltyProgram: false };
}
