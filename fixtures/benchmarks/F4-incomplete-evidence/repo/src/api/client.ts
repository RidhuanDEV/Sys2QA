// All data comes from the shop API, which is a separate service (acme-shop-api).
const API = import.meta.env.VITE_API_URL ?? "https://api.shop.internal.example";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}
