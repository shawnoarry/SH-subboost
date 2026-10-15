import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { decryptTransfer } = require("../../../scripts/decrypt-home-transfer.cjs");
const { schemaSql } = require("../../../scripts/windows-setup.cjs");

function encrypted(password: string) {
  const format = "subboost-home-private-encrypted/v1", salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 600000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(format));
  const data = Buffer.concat([cipher.update(JSON.stringify({ format: "subboost-home-private/v1", yaml: "proxies: []\n", selections: {} })), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ format, kdf: "PBKDF2-SHA256", iterations: 600000, cipher: "AES-256-GCM", salt: salt.toString("base64"), iv: iv.toString("base64"), data: data.toString("base64") });
}

describe("private home transfer", () => {
  it("decrypts locally and rejects a wrong password or altered ciphertext", () => {
    const text = encrypted("a-long-test-only-password");
    expect(decryptTransfer(text, "a-long-test-only-password").yaml).toBe("proxies: []\n");
    expect(() => decryptTransfer(text, "wrong-password")).toThrow("解锁密码不正确");
    const changed = JSON.parse(text); const bytes = Buffer.from(changed.data, "base64"); bytes[0] ^= 1; changed.data = bytes.toString("base64");
    expect(() => decryptTransfer(JSON.stringify(changed), "a-long-test-only-password")).toThrow("解锁密码不正确");
  });

  it("rejects unbounded derivation parameters before attempting decryption", () => {
    const changed = JSON.parse(encrypted("a-long-test-only-password")); changed.iterations = 1;
    expect(() => decryptTransfer(JSON.stringify(changed), "a-long-test-only-password")).toThrow("格式无效");
  });

  it("initializes all shipped migrations and records Prisma-compatible checksums atomically", () => {
    const generated = schemaSql(fileURLToPath(new URL("../../../local/prisma/migrations", import.meta.url)));
    expect(generated.sql.startsWith("BEGIN;")).toBe(true);
    expect(generated.sql.trim().endsWith("COMMIT;")).toBe(true);
    expect(generated.sql).toContain('CREATE TABLE "LocalAdmin"');
    expect(generated.sql).toContain('"RevokedSession"');
    expect(generated.sql.match(/INSERT INTO "_prisma_migrations"/g)?.length).toBe(generated.migrationCount);
  });
});
