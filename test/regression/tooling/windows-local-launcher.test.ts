import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const launcher = createRequire(import.meta.url)("../../../scripts/windows-local.cjs");
let directory: string | undefined;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

describe("Windows double-click launcher", () => {
  it("requires both the database and SubBoost auth API before opening a page", async () => {
    const auth = { setupRequired: true, authenticated: false };
    const read = vi.fn(async (url: string) => url.endsWith("/ready") ? { ok: true, database: "ready" } : auth);
    await expect(launcher.probeApp("http://127.0.0.1:3001", read)).resolves.toEqual(auth);
    await expect(launcher.probeApp("http://127.0.0.1:3001", async () => ({ ok: true }))).resolves.toBeNull();
    await expect(launcher.probeApp("http://127.0.0.1:3001", async () => null)).resolves.toBeNull();
  });

  it("opens setup only for an uninitialized instance and keeps the token in the fragment", () => {
    const base = "http://127.0.0.1:3001";
    const env = { LOCAL_SETUP_TOKEN: "local-test-token" };
    expect(launcher.openUrl(base, { setupRequired: true }, env)).toBe(base + "/login#setup-token=local-test-token");
    expect(launcher.openUrl(base, { setupRequired: false }, env)).toBe(base + "/");
    expect(launcher.openUrl(base, { setupRequired: true }, {})).toBe(base + "/");
  });

  it("delegates browser opening to Windows without PowerShell, and surfaces launch errors", async () => {
    const child = new EventEmitter();
    const spawn = vi.fn(() => child);
    const pending = launcher.openBrowser("http://127.0.0.1:3001/", spawn);
    expect(spawn.mock.calls[0].slice(1)).toEqual([["/d", "/c", "start", "", "http://127.0.0.1:3001/"], { windowsHide: true, stdio: "ignore" }]);
    child.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
    const rejected = launcher.openBrowser("http://127.0.0.1:3001/", spawn);
    child.emit("error", new Error("browser unavailable"));
    await expect(rejected).rejects.toThrow("browser unavailable");
  });

  it("prevents duplicate starts, recovers dead locks and never removes another owner's lock", () => {
    directory = mkdtempSync(join(tmpdir(), "subboost-launcher-"));
    const lock = join(directory, "launch.json");
    const release = launcher.acquireLock(lock);
    expect(typeof release).toBe("function");
    expect(launcher.acquireLock(lock, () => true)).toBeNull();
    release();
    expect(existsSync(lock)).toBe(false);
    writeFileSync(lock, JSON.stringify({ pid: 12345, token: "dead owner" }));
    const releaseRecovered = launcher.acquireLock(lock, () => false);
    expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    writeFileSync(lock, JSON.stringify({ pid: 12345, token: "new owner" }));
    releaseRecovered();
    expect(existsSync(lock)).toBe(true);
  });

  it("does not steal a lock while its owner is still writing it", () => {
    directory = mkdtempSync(join(tmpdir(), "subboost-launcher-"));
    const lock = join(directory, "launch.json");
    writeFileSync(lock, "");
    expect(launcher.acquireLock(lock, () => false)).toBeNull();
  });

  it("recovers a pre-reboot lock even when Windows reused the old PID", () => {
    directory = mkdtempSync(join(tmpdir(), "subboost-launcher-"));
    const lock = join(directory, "launch.json");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "before reboot" }));
    utimesSync(lock, new Date(0), new Date(0));
    const release = launcher.acquireLock(lock, () => true);
    expect(typeof release).toBe("function");
    release();
  });

  it("keeps the default loopback port and rejects invalid startup options", () => {
    expect(launcher.options([])).toEqual({ port: 3001, browser: true });
    expect(launcher.options(["--no-browser", "--port=3002"])).toEqual({ port: 3002, browser: false });
    expect(() => launcher.options(["--port=99999"])).toThrow("端口");
    expect(() => launcher.options(["--host=0.0.0.0"])).toThrow("不支持");
  });
});
