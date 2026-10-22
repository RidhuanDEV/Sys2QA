import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID generator (Data Model §3 "platform ID port"): 48-bit millisecond time + 80-bit randomness, Crockford base32.
 * Monotonic within a millisecond, so IDs created in sequence also sort in sequence.
 */
export function createUlidGenerator(
  now: () => Date = () => new Date(),
  random: (n: number) => Uint8Array = randomBytes,
): () => string {
  let lastTime = -1;
  let lastRandom: Uint8Array = new Uint8Array(10);
  return () => {
    const time = now().getTime();
    if (time === lastTime) {
      lastRandom = increment(lastRandom);
    } else {
      lastTime = time;
      lastRandom = Uint8Array.from(random(10));
    }
    return encodeTime(time) + encodeRandom(lastRandom);
  };
}

/** `<kind>:<ULID>` for operational records (Contract Spec §1). */
export function createIdGenerator(now?: () => Date, random?: (n: number) => Uint8Array): (kind: string) => string {
  const ulid = createUlidGenerator(now, random);
  return (kind) => `${kind}:${ulid()}`;
}

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

function increment(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 255) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  throw new Error("ULID randomness overflow within one millisecond");
}
