import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { decryptTransfer, main } = require("../../../scripts/decrypt-home-transfer.cjs");
const { schemaSql } = require("../../../scripts/windows-setup.cjs");

function encrypted(password: string, payload: unknown = { format: "subboost-home-private/v1", yaml: "proxies: []\n", selections: {} }) {
  const format = "subboost-home-private-encrypted/v1", salt = randomBytes(16), iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 600000, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(format));
  const data = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ format, kdf: "PBKDF2-SHA256", iterations: 600000, cipher: "AES-256-GCM", salt: salt.toString("base64"), iv: iv.toString("base64"), data: data.toString("base64") });
}
afterEach(() => vi.restoreAllMocks());

describe("private home transfer", () => {
  it("rejects malformed envelope sizes and decrypted payload shapes", () => {
    expect(() => decryptTransfer("x".repeat(24 * 1024 * 1024 + 1), "fixture")).toThrow("过大");
    const base = JSON.parse(encrypted("fixture-password"));
    for (const field of ["format", "kdf", "cipher"]) expect(() => decryptTransfer(JSON.stringify({ ...base, [field]: "unsupported" }), "fixture-password")).toThrow("格式无效");
    for (const field of ["salt", "iv", "data"]) expect(() => decryptTransfer(JSON.stringify({ ...base, [field]: "" }), "fixture-password")).toThrow("参数无效");
    for (const payload of [{ format: "wrong" }, { format: "subboost-home-private/v1", yaml: 1 }, { format: "subboost-home-private/v1", yaml: "", selections: null }, { format: "subboost-home-private/v1", yaml: "", selections: "wrong" }]) expect(() => decryptTransfer(encrypted("fixture-password", payload), "fixture-password")).toThrow("已损坏");
  });
  it("validates CLI arguments and exports exclusively to a new private destination", () => {
    const ciphertext = encrypted("fixture-password");
    const output = path.resolve("fixture-transfer-output");
    const written = new Map<string, string>();
    vi.spyOn(fs, "existsSync").mockImplementation((name) => written.has(String(name)));
    vi.spyOn(fs, "readFileSync").mockImplementation(((name: fs.PathOrFileDescriptor) => String(name) === "fixture-password.txt" ? " fixture-password\n" : ciphertext) as typeof fs.readFileSync);
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((name, data) => { written.set(String(name), String(data)); });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(() => main([])).toThrow("必须提供");
    expect(() => main(["--password", "dont-use-command-line-passwords"])).toThrow("用法");
    expect(() => main(["--input"])).toThrow("用法");
    const args = ["--input", "fixture.subboost", "--password-file", "fixture-password.txt", "--output", output];
    main(args);
    expect(mkdir).toHaveBeenCalledWith(output, { recursive: true });
    expect(written.get(path.join(output, "clash-home.yaml"))).toBe("proxies: []\n");
    expect(written.get(path.join(output, "clash-group-selections.json"))).toBe("{}");
    for (const call of write.mock.calls) expect(call[2]).toEqual({ flag: "wx", mode: 0o600 });
    expect(() => main(args)).toThrow("不会覆盖");
    written.delete(path.join(output, "clash-home.yaml")); expect(() => main(args)).toThrow("不会覆盖");
    expect(write).toHaveBeenCalledTimes(2);
  });
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
