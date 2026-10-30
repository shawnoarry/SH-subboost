import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedNode } from "@subboost/core/types/node";
import { nodeTestEngine, nodeTestJob, startNodeTests, NODE_TEST_URL } from "./node-testing";

const m = vi.hoisted(() => ({ stat: vi.fn(), mkdir: vi.fn(), mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), interfaces: vi.fn(), server: vi.fn(), get: vi.fn(), spawn: vi.fn() }));
vi.mock("node:fs/promises", () => ({ default: { stat: m.stat, mkdir: m.mkdir, mkdtemp: m.mkdtemp, writeFile: m.writeFile, rm: m.rm } }));
vi.mock("node:os", () => ({ default: { networkInterfaces: m.interfaces } }));
vi.mock("node:net", () => ({ default: { createServer: m.server } }));
vi.mock("node:http", () => ({ default: { get: m.get } }));
vi.mock("node:child_process", () => ({ spawn: m.spawn }));
vi.mock("./subscription-maintenance", () => ({ MaintenanceError: class extends Error { constructor(message: string, readonly status = 400) { super(message); } } }));

type HttpOptions = { hostname: string; path: string; signal: AbortSignal; headers: Record<string, string> };
type Reply = { status?: number; body?: unknown; error?: unknown; timeout?: boolean; raw?: string; hold?: boolean; responseError?: boolean };
let respond: (options: HttpOptions) => Reply;
let child: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };
const interfaces = { Ethernet: [{ internal: false, family: "IPv4", address: "192.0.2.10", mac: "aa:bb:cc:dd:ee:ff" }] };
const nodes: ParsedNode[] = [{ name: "Fixture", type: "trojan", server: "example.test", port: 443, password: "fixture-only" }];
const root = path.resolve("test-node-engine-fixture");
const jobs = () => (globalThis as unknown as { subboostNodeTestJobs: Map<string, { expires: number; public: { status: string } }> }).subboostNodeTestJobs;
async function finish(id: string) {
  await vi.waitFor(() => expect(nodeTestJob("owner", "sub", id).status).not.toBe("running"));
  return nodeTestJob("owner", "sub", id);
}
beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset()); jobs().clear();
  vi.stubEnv("SUBBOOST_PROJECT_ROOT", root); vi.stubEnv("SUBBOOST_MIHOMO_PATH", path.join(root, "mihomo.exe")); vi.stubEnv("SUBBOOST_TEST_INTERFACE", "");
  m.stat.mockResolvedValue({ isFile: () => true }); m.interfaces.mockReturnValue(interfaces);
  m.mkdir.mockResolvedValue(undefined); m.mkdtemp.mockImplementation(async (prefix) => `${prefix}fixture`); m.writeFile.mockResolvedValue(undefined); m.rm.mockResolvedValue(undefined);
  m.server.mockImplementation(() => {
    const server = Object.assign(new EventEmitter(), { listen: vi.fn((_port, _host, callback) => queueMicrotask(callback)), address: () => ({ port: 19999 }), close: (callback: () => void) => callback() });
    return server;
  });
  child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn((signal = "SIGTERM") => { child.signalCode = signal; queueMicrotask(() => child.emit("exit", null)); return true; }) });
  m.spawn.mockReturnValue(child);
  respond = (options) => ({ status: 200, body: options.path === "/version" ? { version: "test" } : { delay: 42 } });
  m.get.mockImplementation((options: HttpOptions, callback: (response: unknown) => void) => {
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn((error: unknown) => request.emit("error", error)) });
    const onAbort = () => request.destroy(new Error("aborted"));
    options.signal.addEventListener("abort", onAbort, { once: true });
    queueMicrotask(() => {
      const reply = respond(options);
      if (reply.hold) return;
      options.signal.removeEventListener("abort", onAbort);
      if (reply.timeout) { request.emit("timeout"); return; }
      if (reply.error) { request.emit("error", reply.error); return; }
      const response = Object.assign(new EventEmitter(), { statusCode: reply.status, setEncoding: vi.fn(), destroy: vi.fn(() => response.emit("error", new Error("oversized"))) });
      callback(response);
      if (reply.responseError) response.emit("error", new Error("response interrupted"));
      else { response.emit("data", reply.raw ?? JSON.stringify(reply.body)); response.emit("end"); }
    });
    return request;
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("isolated node test lifecycle", () => {
  it("reports cancellation during filesystem setup without starting a core", async () => {
    let fail!: (error: Error) => void;
    m.mkdir.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]);
    nodeTestJob("owner", "sub", started.id, true); fail(new Error("directory unavailable"));
    const result = await finish(started.id);
    expect(result.status).toBe("cancelled"); expect(result.results[0]).toMatchObject({ status: "cancelled", message: "已取消" });
    expect(m.spawn).not.toHaveBeenCalled(); expect(m.rm).not.toHaveBeenCalled();
  });
  it("uses a loopback controller and private disposable files, never the live Clash controller", async () => {
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]);
    started.results[0].name = "mutated caller copy";
    const result = await finish(started.id);
    expect(result.results[0]).toMatchObject({ name: "Fixture", status: "available", delay: 42, checkedAt: expect.any(String) });
    expect(m.mkdir).toHaveBeenCalledWith(path.join(root, "data/node-tests"), { recursive: true, mode: 0o700 });
    const [filename, content, permissions] = m.writeFile.mock.calls[0];
    expect(permissions).toEqual({ mode: 0o600 });
    expect(JSON.parse(content)).toMatchObject({ "external-controller": "127.0.0.1:19999", tun: { enable: false, "auto-route": false }, "proxy-groups": [], rules: ["MATCH,REJECT"] });
    expect(m.spawn).toHaveBeenCalledWith(path.join(root, "mihomo.exe"), ["-d", path.dirname(filename), "-f", filename], expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" }) }));
    for (const [options] of m.get.mock.calls) expect(options).toMatchObject({ hostname: "127.0.0.1", headers: { Authorization: expect.stringMatching(/^Bearer [0-9a-f]{64}$/) } });
    expect(m.get.mock.calls.at(-1)![0].path).toContain(encodeURIComponent(NODE_TEST_URL));
    expect(child.kill).toHaveBeenCalledOnce(); expect(m.rm).toHaveBeenCalledWith(path.dirname(filename), expect.objectContaining({ recursive: true, force: true }));
    expect(() => nodeTestJob("intruder", "sub", started.id, true)).toThrow("不存在");
    expect(() => nodeTestJob("owner", "other-sub", started.id)).toThrow("不存在");
    expect(nodeTestJob("owner", "sub", started.id, true).status).toBe("finished");
  });

  it.each([
    [{ status: 500, body: { message: "deadline exceeded" } }, "timeout"],
    [{ status: 500, body: { message: "rejected" } }, "failed"],
    [{ body: {} }, "failed"],
    [{ status: 200, raw: "invalid-json" }, "failed"],
    [{ status: 200, raw: "x".repeat(16385) }, "failed"],
    [{ timeout: true }, "timeout"],
    [{ error: new Error("connection refused") }, "failed"],
    [{ responseError: true }, "failed"],
  ] as [Reply, string][])("classifies a failed probe as %s → %s", async (reply, status) => {
    respond = (options) => options.path === "/version" ? { status: 200, body: {} } : reply;
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]);
    expect((await finish(started.id)).results[0].status).toBe(status);
    expect(m.rm).toHaveBeenCalledOnce();
  });

  it("skips dependent and unsupported nodes without starting a core", async () => {
    const unsupported = [{ ...nodes[0], type: "ssh" }, { ...nodes[0], "dialer-proxy": "another" }] as ParsedNode[];
    const started = await startNodeTests("owner", "sub", unsupported, ["node-0", "node-1"]);
    expect((await finish(started.id)).results.map((row) => row.status)).toEqual(["unsupported", "unsupported"]);
    expect(m.spawn).not.toHaveBeenCalled(); expect(m.writeFile).not.toHaveBeenCalled();
  });

  it("cancels in-flight requests and queued work, limiting concurrency to three", async () => {
    respond = (options) => options.path === "/version" ? { status: 200, body: {} } : { hold: true };
    const started = await startNodeTests("owner", "sub", Array.from({ length: 8 }, () => nodes[0]), Array.from({ length: 8 }, (_, i) => `node-${i}`));
    await vi.waitFor(() => expect(m.get).toHaveBeenCalledTimes(4));
    await expect(startNodeTests("owner", "another", nodes, ["node-0"])).rejects.toThrow("已有检测任务");
    nodeTestJob("owner", "sub", started.id, true);
    const result = await finish(started.id);
    expect(result.status).toBe("cancelled"); expect(result.results.every((row) => row.status === "cancelled")).toBe(true);
    expect(m.get).toHaveBeenCalledTimes(4); expect(m.rm).toHaveBeenCalledOnce();
  });

  it("serializes competing starts after asynchronous engine discovery", async () => {
    respond = () => ({ hold: true });
    const attempts = await Promise.allSettled([startNodeTests("owner", "sub", nodes, ["node-0"]), startNodeTests("owner", "sub", nodes, ["node-0"])]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const result = attempts.find((entry) => entry.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof startNodeTests>>>;
    await vi.waitFor(() => expect(m.get).toHaveBeenCalled());
    nodeTestJob("owner", "sub", result.value.id, true); await finish(result.value.id);
  });

  it("marks startup failures and removes only its own temporary directory", async () => {
    m.writeFile.mockRejectedValue(new Error("disk full"));
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]);
    expect((await finish(started.id)).results[0]).toMatchObject({ status: "failed", message: expect.stringContaining("未能启动") });
    expect(m.spawn).not.toHaveBeenCalled(); expect(m.rm).toHaveBeenCalledOnce();
    m.writeFile.mockResolvedValue(undefined); m.mkdtemp.mockResolvedValue(path.join(root, "unrelated")); m.spawn.mockImplementation(() => { throw new Error("spawn failed"); }); m.rm.mockClear();
    const second = await startNodeTests("owner", "sub", nodes, ["node-0"]); await finish(second.id);
    expect(m.rm).not.toHaveBeenCalled();
  });

  it("escalates shutdown only if the isolated core ignores its first stop signal", async () => {
    child.kill.mockImplementation((signal) => { if (signal === "SIGKILL") { child.signalCode = signal; queueMicrotask(() => child.emit("exit", null)); } return true; });
    vi.useFakeTimers();
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(nodeTestJob("owner", "sub", started.id).status).toBe("finished"); expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
  });

  it("handles a core that exits before readiness, including cleanup errors", async () => {
    vi.useFakeTimers(); m.rm.mockRejectedValue(new Error("locked temp file"));
    m.spawn.mockImplementation(() => { queueMicrotask(() => { child.exitCode = 1; child.emit("exit", 1); }); return child; });
    respond = () => ({ error: new Error("not listening") });
    const started = await startNodeTests("owner", "sub", nodes, ["node-0"]); await vi.advanceTimersByTimeAsync(500);
    expect(nodeTestJob("owner", "sub", started.id).results[0].status).toBe("failed"); expect(child.kill).not.toHaveBeenCalled();
  });

  it("evicts expired finished jobs and refuses unavailable engines without spawning", async () => {
    jobs().set("old", { expires: 0, public: { status: "finished" } });
    m.stat.mockRejectedValue(new Error("missing"));
    await expect(startNodeTests("owner", "sub", nodes, ["node-0"])).rejects.toThrow("尚未配置检测核心");
    expect(jobs().has("old")).toBe(false); expect(m.spawn).not.toHaveBeenCalled();
    vi.stubEnv("SUBBOOST_MIHOMO_PATH", "relative.exe"); m.stat.mockResolvedValue({ isFile: () => false });
    expect((await nodeTestEngine()).available).toBe(false);
    m.stat.mockResolvedValue({ isFile: () => true }); m.interfaces.mockReturnValue({ ...interfaces, WiFi: interfaces.Ethernet });
    expect((await nodeTestEngine()).message).toContain("未能唯一确定");
    vi.stubEnv("SUBBOOST_TEST_INTERFACE", "WiFi"); expect((await nodeTestEngine()).interfaceName).toBe("WiFi");
    vi.stubEnv("SUBBOOST_TEST_INTERFACE", "not-present"); expect((await nodeTestEngine()).available).toBe(false);
  });
});
