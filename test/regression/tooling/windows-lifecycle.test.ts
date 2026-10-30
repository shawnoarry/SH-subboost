import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import cp from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All writes, subprocesses and sockets are replaced before invoking either entry point.
// The fixture never starts PostgreSQL, touches local/.env or opens a real listener.
const require = createRequire(import.meta.url);
const launcherPath = require.resolve("../../../scripts/windows-local.cjs");
const setupPath = require.resolve("../../../scripts/windows-setup.cjs");
const root = path.resolve(path.dirname(launcherPath), "..");
const fixture = path.resolve("windows-setup-fixture");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
type Child = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
let launcher: { main(args?: string[]): Promise<void>; probeApp(base: string): Promise<unknown> };
let setup: { initialize(root: string): Promise<{ existing: boolean; port?: number; migrationCount?: number }> };
let files: Map<string, string>;
let spawn: ReturnType<typeof vi.spyOn>;
let web: Child | undefined;
let available: boolean;
let existing: boolean;
let webReady: boolean;
let occupied: string;
let pgRunning: boolean;
let failCommand: string;
let failSpawn: boolean;
let exitCode: number;
let signalStop: boolean;
let missing: string;
let busyPorts: number;
let databaseCreated: boolean;
const commands = () => spawn.mock.calls.map(([executable, args]) => `${path.basename(String(executable))}:${(args as string[]).at(-1)}`);
const envPath = (base = fixture) => path.join(base, "local", ".env");
const run = async <T,>(operation: Promise<T>): Promise<T> => {
  const outcome = operation.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(130000);
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
};

beforeEach(() => {
  vi.useFakeTimers(); Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  files = new Map([[envPath(root), "APP_URL=http://127.0.0.1:3001\nLOCAL_SETUP_TOKEN=fixture-token\n"]]);
  available = false; existing = false; webReady = true; occupied = "ECONNREFUSED"; pgRunning = false; failCommand = ""; failSpawn = false; exitCode = 0; signalStop = false; missing = ""; busyPorts = 0; databaseCreated = false; web = undefined;
  spawn = vi.spyOn(cp, "spawn").mockImplementation(((executable: string, args: string[], options: { stdio: unknown }) => {
    const child: Child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { queueMicrotask(() => child.emit("exit", 0)); return true; }) });
    const executableName = path.basename(executable);
    const command = `${executableName}:${args.at(-1)}`;
    if (options.stdio === "inherit") {
      web = child;
      if (failSpawn) queueMicrotask(() => child.emit("error", new Error("spawn rejected")));
    } else queueMicrotask(() => {
      child.stdout.emit("data", "fixture output"); child.stderr.emit("data", "fixture stderr");
      if (command === failCommand && failSpawn) { child.emit("error", new Error("process unavailable")); return; }
      const code = command === failCommand ? 1 : args.at(-1) === "status" ? (pgRunning ? 0 : 3) : 0;
      if (executableName === "initdb.exe" && code === 0) databaseCreated = true;
      child.emit("exit", code);
    });
    return child;
  }) as typeof cp.spawn);
  delete require.cache[launcherPath]; delete require.cache[setupPath];
  launcher = require(launcherPath); setup = require(setupPath);
  const originalRead = fs.readFileSync;
  vi.spyOn(fs, "existsSync").mockImplementation((name) => {
    const file = String(name);
    if (missing && file.endsWith(missing)) return false;
    if (files.has(file)) return true;
    if (file.endsWith("PG_VERSION")) return file === path.join(root, "data/postgres/PG_VERSION") || databaseCreated;
    if (file.endsWith("server.js") || /(?:initdb|pg_ctl|createdb|psql)\.exe$/.test(file)) return true;
    return false;
  });
  vi.spyOn(fs, "readFileSync").mockImplementation(((name: fs.PathOrFileDescriptor, options: unknown) => {
    const file = String(name);
    if (files.has(file)) return options === "utf8" ? files.get(file)! : Buffer.from(files.get(file)!);
    if (file.endsWith("migration.sql")) return "CREATE TABLE fixture (id INTEGER);";
    if (file.endsWith(".json") || file.endsWith(".env")) throw new Error("fixture file absent");
    return originalRead(name, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  vi.spyOn(fs, "readdirSync").mockImplementation(((name: fs.PathLike) => String(name).endsWith("migrations") ? ["20260101000000_initial"] : []) as typeof fs.readdirSync);
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  const descriptors = new Map<number, string>(); let nextFd = 9000;
  vi.spyOn(fs, "openSync").mockImplementation((name) => { const file = String(name); if (files.has(file)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); files.set(file, ""); descriptors.set(++nextFd, file); return nextFd; });
  vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
  vi.spyOn(fs, "writeFileSync").mockImplementation((name, data, options) => {
    const file = typeof name === "number" ? descriptors.get(name)! : String(name);
    if (typeof options === "object" && options?.flag === "wx" && files.has(file)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    files.set(file, String(data));
  });
  vi.spyOn(fs, "appendFileSync").mockImplementation((name, data) => { files.set(String(name), (files.get(String(name)) ?? "") + String(data)); });
  vi.spyOn(fs, "unlinkSync").mockImplementation((name) => { files.delete(String(name)); });
  vi.spyOn(fs, "statSync").mockImplementation(() => ({ mtimeMs: Date.now() }) as fs.Stats);
  vi.spyOn(net, "connect").mockImplementation((() => {
    const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
    queueMicrotask(() => { if (["connect", "timeout"].includes(occupied)) socket.emit(occupied); else socket.emit("error", { code: occupied }); });
    return socket;
  }) as typeof net.connect);
  vi.spyOn(net, "createServer").mockImplementation((() => {
    const server = Object.assign(new EventEmitter(), { listen: (port: number, _host: string, callback: () => void) => queueMicrotask(() => { if (port < 55432 + busyPorts) server.emit("error", new Error("busy")); else callback(); }), close: (callback: () => void) => callback() });
    return server;
  }) as typeof net.createServer);
  vi.spyOn(http, "get").mockImplementation(((url: string, _options: unknown, callback: (response: unknown) => void) => {
    const request = Object.assign(new EventEmitter(), { destroy: () => request.emit("error", new Error("request stopped")) });
    queueMicrotask(() => {
      const ready = available || existing || Boolean(web && webReady && !failSpawn);
      const body = !ready ? {} : url.endsWith("/ready") ? { ok: true, database: "ready" } : { setupRequired: false, authenticated: false };
      const response = Object.assign(new EventEmitter(), { statusCode: 200, setEncoding: vi.fn(), destroy: () => response.emit("error", new Error("too large")) });
      callback(response); response.emit("data", JSON.stringify(body)); response.emit("end");
    });
    return request;
  }) as typeof http.get);
  vi.spyOn(console, "log").mockImplementation((message) => {
    if (String(message).startsWith("SubBoost 已就绪") && web) queueMicrotask(() => { if (signalStop) process.emit("SIGINT"); else web!.emit("exit", exitCode); });
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); Object.defineProperty(process, "platform", platform); delete require.cache[launcherPath]; delete require.cache[setupPath]; });

describe("Windows launcher process ownership", () => {
  it("waits for another launcher without starting a second server or database", async () => {
    files.set(path.join(root, "data/runtime/subboost-launcher-3001.json"), JSON.stringify({ pid: process.pid, token: "active" }));
    vi.mocked(console.log).mockImplementation((message) => { if (String(message).startsWith("另一个窗口")) available = true; });
    await run(launcher.main(["--no-browser"])); expect(spawn).not.toHaveBeenCalled();
    expect(files.has(path.join(root, "data/runtime/subboost-launcher-3001.json"))).toBe(true);
  });
  it("keeps a running service usable if opening the browser fails", async () => {
    existing = true; vi.stubEnv("ComSpec", ""); failCommand = "cmd.exe:http://127.0.0.1:3001/";
    await run(launcher.main([])); expect(console.log).toHaveBeenCalledWith(expect.stringContaining("未能自动打开浏览器"));
  });
  it.each(["oversized", "malformed", "status", "timeout", "network"])("treats a %s health response as not ready", async (failure) => {
    vi.mocked(http.get).mockImplementation(((url: string, _options: unknown, callback: (response: unknown) => void) => {
      const request = Object.assign(new EventEmitter(), { destroy: () => request.emit("error", new Error("closed")) });
      queueMicrotask(() => {
        if (failure === "timeout") { request.emit("timeout"); return; }
        if (failure === "network") { request.emit("error", new Error("refused")); return; }
        const response = Object.assign(new EventEmitter(), { statusCode: failure === "status" ? 503 : 200, setEncoding: vi.fn(), destroy: () => response.emit("error", new Error("oversized")) });
        callback(response); response.emit("data", failure === "oversized" ? "x".repeat(16385) : "not-json"); response.emit("end");
      });
      return request;
    }) as typeof http.get);
    expect(await run(launcher.probeApp("http://127.0.0.1:3001"))).toBeNull();
  });
  it("rejects unsupported platforms without touching any installation", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await expect(run(launcher.main([]))).rejects.toThrow("Windows");
    await expect(run(setup.initialize(fixture))).rejects.toThrow("Windows"); expect(spawn).not.toHaveBeenCalled();
  });
  it("opens an already running instance without starting or stopping its database", async () => {
    existing = true; await run(launcher.main([]));
    expect(commands()).toHaveLength(1); expect(commands()[0]).toContain("http://127.0.0.1:3001/"); expect(files.get(envPath(root))).toContain("fixture-token");
  });
  it.each([false, true])("stops only a database it started (pre-existing: %s)", async (running) => {
    pgRunning = running; const listeners = process.listenerCount("SIGINT");
    await run(launcher.main(["--no-browser"]));
    expect(commands()).toContain("pg_ctl.exe:status");
    expect(commands().includes("pg_ctl.exe:start")).toBe(!running); expect(commands().includes("pg_ctl.exe:stop")).toBe(!running);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect([...files.keys()].some((file) => file.includes("subboost-launcher-"))).toBe(false);
  });
  it("gracefully handles Ctrl+C and reports unexpected server exit codes", async () => {
    signalStop = true; await run(launcher.main(["--no-browser"])); expect(web!.kill).toHaveBeenCalledWith("SIGTERM");
    signalStop = false; web = undefined; exitCode = 2;
    await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow("退出码 2");
    expect(commands().filter((command) => command === "pg_ctl.exe:stop")).toHaveLength(2);
  });
  it.each([".env", "server.js", "pg_ctl.exe", "PG_VERSION"])("leaves data intact when %s is missing", async (file) => {
    missing = file; await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled(); expect(files.get(envPath(root))).toContain("fixture-token");
  });
  it("reports database startup failure without pretending that it owns a running database", async () => {
    failCommand = "pg_ctl.exe:start"; await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow("数据库启动失败");
    expect(commands()).not.toContain("pg_ctl.exe:stop");
  });
  it.each(["connect", "timeout", "EACCES"])("never terminates an unrelated service when the port reports %s", async (event) => {
    occupied = event; await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow("端口 3001 已被占用");
    expect(web).toBeUndefined(); expect(commands()).toContain("pg_ctl.exe:stop");
  });
  it("leaves a concurrently started healthy instance and its database running", async () => {
    occupied = "connect";
    const connect = vi.mocked(net.connect).getMockImplementation()!;
    vi.spyOn(net, "connect").mockImplementation(((...args: unknown[]) => { available = true; return Reflect.apply(connect, net, args); }) as typeof net.connect);
    await run(launcher.main(["--no-browser"])); expect(web).toBeUndefined(); expect(commands()).not.toContain("pg_ctl.exe:stop");
  });
  it("cleans up after a web spawn failure or readiness timeout", async () => {
    failSpawn = true; await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow("提前停止"); expect(commands()).toContain("pg_ctl.exe:stop");
    failSpawn = false; web = undefined; webReady = false;
    await expect(run(launcher.main(["--no-browser"]))).rejects.toThrow("超时"); expect(web!.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("reports a database stop failure without recreating or deleting the database", async () => {
    failCommand = "pg_ctl.exe:stop"; await run(launcher.main(["--no-browser"]));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("未完成正常关闭"));
    expect(commands().some((command) => command.startsWith("initdb"))).toBe(false);
  });
});

describe("Windows new installation safeguards", () => {
  it("rejects missing migrations or a nonempty database directory before initialization", async () => {
    const exists = vi.mocked(fs.existsSync).getMockImplementation()!;
    vi.mocked(fs.existsSync).mockImplementation((name) => String(name) === path.join(fixture, "data/postgres") || exists(name));
    vi.mocked(fs.readdirSync).mockReturnValue(["existing-data"] as unknown as ReturnType<typeof fs.readdirSync>);
    await expect(run(setup.initialize(fixture))).rejects.toThrow("已有或未完成");
    vi.mocked(fs.existsSync).mockImplementation(exists); vi.mocked(fs.readdirSync).mockReturnValue([]);
    await expect(run(setup.initialize(fixture))).rejects.toThrow("缺少数据库迁移"); expect(spawn).not.toHaveBeenCalled();
  });
  it("does not replace a preexisting recovery file when a retry fails", async () => {
    const recovery = path.join(fixture, "data/runtime/setup-recovery.env"); files.set(recovery, "older recovery fixture"); failCommand = "createdb.exe:subboost";
    await expect(run(setup.initialize(fixture))).rejects.toThrow("程序执行失败"); expect(files.get(recovery)).toBe("older recovery fixture");
  });
  it("handles a full disk before database creation without leaving password files", async () => {
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(run(setup.initialize(fixture))).rejects.toThrow("disk full"); expect(spawn).not.toHaveBeenCalled();
    expect([...files.keys()].some((name) => name.endsWith(".pw"))).toBe(false);
  });
  it("initializes a fresh database on an available loopback port and removes only its temporary inputs", async () => {
    busyPorts = 2; const result = await run(setup.initialize(fixture));
    expect(result).toEqual({ existing: false, port: 55434, migrationCount: 1 });
    expect(files.get(envPath())).toContain("@127.0.0.1:55434/subboost");
    expect(files.get(path.join(fixture, "data/postgres/postgresql.conf"))).toContain("listen_addresses = '127.0.0.1'");
    expect(commands()).toContain("createdb.exe:subboost"); expect(commands()).toContain("pg_ctl.exe:stop");
    expect([...files.keys()].some((name) => /setup-.*\.(pw|sql)$/.test(name))).toBe(false);
    expect([...files.keys()].some((name) => name.endsWith("subboost-setup.json"))).toBe(false);
  });
  it("preserves an installed instance and refuses partial installations", async () => {
    files.set(envPath(), "existing fixture config"); databaseCreated = true;
    await expect(run(setup.initialize(fixture))).resolves.toEqual({ existing: true }); expect(spawn).not.toHaveBeenCalled();
    databaseCreated = false; await expect(run(setup.initialize(fixture))).rejects.toThrow("已有或未完成的安装");
    expect(files.get(envPath())).toBe("existing fixture config");
  });
  it("refuses duplicate installation, missing runtime and exhausted ports without starting processes", async () => {
    files.set(path.join(fixture, "data/runtime/subboost-setup.json"), JSON.stringify({ pid: process.pid, token: "another-owner" }));
    await expect(run(setup.initialize(fixture))).rejects.toThrow("另一个窗口");
    files.clear(); missing = "initdb.exe"; await expect(run(setup.initialize(fixture))).rejects.toThrow("缺少便携 PostgreSQL");
    missing = ""; busyPorts = 10; await expect(run(setup.initialize(fixture))).rejects.toThrow("候选端口均被占用"); expect(spawn).not.toHaveBeenCalled();
  });
  it("preserves recovery keys if setup fails after initdb, stops its database and retains the original failure", async () => {
    failCommand = "createdb.exe:subboost";
    await expect(run(setup.initialize(fixture))).rejects.toThrow("程序执行失败");
    const recovery = path.join(fixture, "data/runtime/setup-recovery.env");
    expect(files.get(recovery)).toContain("DATABASE_URL="); expect(files.has(envPath())).toBe(false); expect(commands()).toContain("pg_ctl.exe:stop");
    expect([...files.keys()].some((name) => /setup-.*\.(pw|sql)$/.test(name))).toBe(false);
  });
  it("retains recovery data and reports database shutdown failures", async () => {
    failCommand = "pg_ctl.exe:stop"; failSpawn = true;
    await run(setup.initialize(fixture));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("未正常停止")); expect(files.has(envPath())).toBe(true);
  });
});
