import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * AES-256-GCM secret box with a machine-local master key (32 random bytes).
 * Stored format: `v1:<b64 iv>:<b64 ciphertext+tag>`. The key file is created
 * on first encryption (mode 0600) and never logged.
 */
export interface SecretBox {
  encrypt(plain: string): Promise<string>;
  /** Null when the blob cannot be decrypted (missing/changed key, corrupt). */
  decrypt(blob: string): Promise<string | null>;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromB64(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(text, "base64"));
}

function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Reads the key file; null when absent or malformed. */
function readKeyFile(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  const raw = new Uint8Array(readFileSync(path));
  return raw.byteLength === KEY_BYTES ? raw : null;
}

/** Creates the key file exclusively (another writer may win the race). */
function createKeyFile(path: string): Uint8Array {
  mkdirSync(dirname(path), { recursive: true });
  const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    writeFileSync(path, raw, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = readKeyFile(path);
    if (!existing) throw new Error("Chave mestra inválida em disco.");
    return existing;
  }
}

export function createSecretBox(options: { keyPath: string } | { key: Uint8Array }): SecretBox {
  let cached: Promise<CryptoKey> | null =
    "key" in options ? importKey(options.key) : null;
  const keyPath = "keyPath" in options ? options.keyPath : null;

  async function loadKey(create: boolean): Promise<CryptoKey | null> {
    if (cached) return cached;
    if (!keyPath) return null;
    let raw = readKeyFile(keyPath);
    if (!raw) {
      if (!create) return null;
      if (existsSync(keyPath)) {
        // Never overwrite a malformed key: other secrets may depend on it.
        throw new Error("A chave mestra (data/.master.key) está corrompida. Remova-a e cadastre as chaves novamente.");
      }
      raw = createKeyFile(keyPath);
    }
    cached = importKey(raw);
    return cached;
  }

  return {
    async encrypt(plain) {
      const key = (await loadKey(true))!;
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const data = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain)),
      );
      return `${VERSION}:${b64(iv)}:${b64(data)}`;
    },
    async decrypt(blob) {
      const [version, ivText, dataText] = blob.split(":");
      if (version !== VERSION || !ivText || !dataText) return null;
      try {
        const key = await loadKey(false);
        if (!key) return null;
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fromB64(ivText) },
          key,
          fromB64(dataText),
        );
        return new TextDecoder().decode(plain);
      } catch {
        return null;
      }
    },
  };
}

/** Last 4 characters for display ("••••1234"); never more. */
export function last4(secret: string | null): string | null {
  if (!secret) return null;
  return secret.length <= 4 ? null : secret.slice(-4);
}
