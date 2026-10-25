import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { AsyncEntry } from "@napi-rs/keyring";

/** Where secret values live (ADR-011). Implementations never log or return values except through `get`. */
export interface SecretBackend {
  readonly kind: "os" | "file" | "memory";
  set(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | undefined>;
  delete(ref: string): Promise<boolean>;
}

export class SecretStoreError extends Error {
  override readonly name = "SecretStoreError";
  constructor(
    readonly code: "SECRET_STORE_UNAVAILABLE" | "SECRET_STORE_LOCKED" | "SECRET_CORRUPT",
    message: string,
    readonly remediation: string,
  ) {
    super(message);
  }
}

const SERVICE = "sys2qa";

/** OS credential store: macOS Keychain, Windows Credential Manager, Linux Secret Service (never the volatile kernel keyring). */
export class OsSecretBackend implements SecretBackend {
  readonly kind = "os" as const;
  #entry(ref: string): AsyncEntry {
    return new AsyncEntry(SERVICE, ref, { linux: { store: "secret-service" } });
  }
  async set(ref: string, value: string): Promise<void> {
    await this.#entry(ref).setPassword(value);
  }
  async get(ref: string): Promise<string | undefined> {
    return (await this.#entry(ref).getPassword()) ?? undefined;
  }
  async delete(ref: string): Promise<boolean> {
    return this.#entry(ref).deleteCredential();
  }

  /** Whether the OS store works here: a probe entry is written, read back and deleted. */
  static async available(): Promise<boolean> {
    const backend = new OsSecretBackend();
    const probe = `secretref:probe.${randomBytes(6).toString("hex")}`;
    try {
      await backend.set(probe, "probe");
      const ok = (await backend.get(probe)) === "probe";
      await backend.delete(probe);
      return ok;
    } catch {
      return false;
    }
  }
}

interface EncryptedFile {
  version: 1;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  entries: Record<string, { iv: string; data: string; tag: string }>;
}

const KDF = { N: 2 ** 15, r: 8, p: 1 };

/** Passphrase-encrypted file (AES-256-GCM per entry, scrypt key, reference as AAD); see ADR-011. */
export class EncryptedFileSecretBackend implements SecretBackend {
  readonly kind = "file" as const;
  #key: Buffer | undefined;
  #salt: Buffer | undefined;

  constructor(
    private readonly path: string,
    private readonly passphrase: string,
  ) {
    if (passphrase.length < 12) {
      throw new SecretStoreError(
        "SECRET_STORE_LOCKED",
        "the secrets passphrase is too short",
        "Set SYS2QA_SECRETS_PASSPHRASE to at least 12 characters.",
      );
    }
  }

  #read(): EncryptedFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, kdf: { name: "scrypt", salt: randomBytes(16).toString("base64"), ...KDF }, entries: {} };
      throw error;
    }
    try {
      return JSON.parse(raw) as EncryptedFile;
    } catch {
      throw new SecretStoreError(
        "SECRET_CORRUPT",
        "the encrypted secrets file is damaged",
        "Restore secrets.enc from a backup, or delete it and enter the credentials again.",
      );
    }
  }

  #keyFor(file: EncryptedFile): Buffer {
    const salt = Buffer.from(file.kdf.salt, "base64");
    if (!this.#key || !this.#salt?.equals(salt)) {
      this.#key = scryptSync(this.passphrase, salt, 32, {
        N: file.kdf.N,
        r: file.kdf.r,
        p: file.kdf.p,
        maxmem: 128 * file.kdf.N * file.kdf.r * 2,
      });
      this.#salt = salt;
    }
    return this.#key;
  }

  #write(file: EncryptedFile): void {
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  async set(ref: string, value: string): Promise<void> {
    const file = this.#read();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#keyFor(file), iv);
    cipher.setAAD(Buffer.from(ref));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    file.entries[ref] = {
      iv: iv.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    this.#write(file);
  }

  async get(ref: string): Promise<string | undefined> {
    const file = this.#read();
    const entry = file.entries[ref];
    if (!entry) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#keyFor(file), Buffer.from(entry.iv, "base64"));
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(entry.data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new SecretStoreError(
        "SECRET_STORE_LOCKED",
        "the secret cannot be decrypted (wrong passphrase or tampered entry)",
        "Check SYS2QA_SECRETS_PASSPHRASE; if the entry was tampered with, enter the credential again.",
      );
    }
  }

  async delete(ref: string): Promise<boolean> {
    const file = this.#read();
    if (!(ref in file.entries)) return false;
    delete file.entries[ref];
    this.#write(file);
    return true;
  }
}

/** In-memory backend for tests. */
export class MemorySecretBackend implements SecretBackend {
  readonly kind = "memory" as const;
  readonly values = new Map<string, string>();
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async get(ref: string): Promise<string | undefined> {
    return this.values.get(ref);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
}

/**
 * Backend selection (ADR-011): `auto` uses the OS store when a probe succeeds, else the encrypted file when a passphrase
 * is set; otherwise secrets are unavailable, never stored unencrypted.
 */
export async function selectSecretBackend(options: {
  mode: "auto" | "os" | "file";
  filePath: string;
  passphrase?: string;
  /** Overrides the OS-store probe (tests must not touch a real keychain). */
  osAvailable?: () => Promise<boolean>;
}): Promise<SecretBackend> {
  const unavailable = () =>
    new SecretStoreError(
      "SECRET_STORE_UNAVAILABLE",
      "no secret store is available: the OS credential store cannot be used here and no passphrase is set for the encrypted file",
      "Unlock or install the OS credential store (Secret Service on Linux), or set SYS2QA_SECRETS_PASSPHRASE to use the encrypted file.",
    );
  if (options.mode !== "file" && (await (options.osAvailable ?? OsSecretBackend.available)()))
    return new OsSecretBackend();
  if (options.mode === "os") throw unavailable();
  if (!options.passphrase) throw unavailable();
  return new EncryptedFileSecretBackend(options.filePath, options.passphrase);
}
