/**
 * Address classification for URL scope checks (SEC-007, SEC-008). This is the configuration-time and decision-time
 * check on the literal host; the egress proxy re-checks resolved addresses at connection time (ADR-007, IMP-401).
 * Implemented without node:net, which only runtime-observer may import (Architecture §4.1).
 */
export type HostClass = "public" | "loopback" | "private" | "link_local" | "metadata" | "unspecified";

const METADATA_HOSTS = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata",
  "100.100.100.200",
]);

export function classifyHost(hostname: string): HostClass {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (METADATA_HOSTS.has(host)) return "metadata";
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const v4 = parseIPv4(host);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(host);
  if (v6) return classifyIPv6(v6);
  return "public";
}

function parseIPv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : undefined;
}

function classifyIPv4([a, b]: number[]): HostClass {
  if (a === undefined || b === undefined) return "public";
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link_local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127))
    return "private";
  return "public";
}

/** Returns the eight 16-bit groups of an IPv6 literal (including an embedded dotted IPv4 tail), or undefined. */
function parseIPv6(host: string): number[] | undefined {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/.test(host)) return undefined;
  let text = host;
  const tail: number[] = [];
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4) {
    const p = parseIPv4(v4[1]!);
    if (!p) return undefined;
    tail.push((p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!);
    text = text.slice(0, v4.index + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (s: string) =>
    s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = toGroups(halves[0]!);
  const rest = halves.length === 2 ? toGroups(halves[1]!) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return undefined;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return groups.every((g) => Number.isInteger(g)) ? groups : undefined;
}

function classifyIPv6(g: number[]): HostClass {
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) is classified by its IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return classifyIPv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  if ((g[0]! & 0xfe00) === 0xfc00) return "private";
  if ((g[0]! & 0xffc0) === 0xfe80) return "link_local";
  return "public";
}
