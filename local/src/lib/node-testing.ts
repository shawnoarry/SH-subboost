import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { loadMihomoYaml } from "@subboost/core/config/yaml-schema";
import { applySourceDnsDependencies, dnsPatternMatches, type SourceDnsCarrier } from "@subboost/core/subscription/source-dns";
import { DEFAULT_DNS_CONFIG } from "@subboost/core/generator/dns";
import { isMihomoSupportedProxyNode, sanitizeMihomoProxyNode } from "@subboost/core/mihomo/proxy-sanitizer";
import type { ParsedNode } from "@subboost/core/types/node";
import type { NodeTestJob, NodeTestResult } from "@subboost/core/subscription/maintenance";
import { MaintenanceError } from "./subscription-maintenance";

export const NODE_TEST_URL = "https://www.gstatic.com/generate_204";
export const NODE_TEST_TIMEOUT = 5000;
export const NODE_TEST_BATCH_LIMIT = 200;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Job = { ownerId: string; subscriptionId: string; public: NodeTestJob; controller: AbortController; expires: number };
const globalJobs = globalThis as unknown as { subboostNodeTestJobs?: Map<string, Job> };
const jobs = globalJobs.subboostNodeTestJobs ??= new Map();

export function physicalInterfaces(interfaces = os.networkInterfaces()): string[] {
  return Object.entries(interfaces).filter(([name, addresses]) =>
    !/loopback|clash|mihomo|tun|tap|virtual|vmware|vbox|hyper-v|tailscale|zerotier|docker|wsl/i.test(name) &&
    addresses?.some((address) => !address.internal && address.family === "IPv4" && !address.address.startsWith("169.254.") && address.mac !== "00:00:00:00:00:00")
  ).map(([name]) => name);
}

export async function nodeTestEngine() {
  const candidates = [process.env.SUBBOOST_MIHOMO_PATH,
    path.resolve(process.env.SUBBOOST_PROJECT_ROOT || path.resolve(process.cwd(), ".."), "data/runtime/mihomo/mihomo.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Clash Verge", "verge-mihomo.exe")].filter((value): value is string => Boolean(value));
  let executable: string | undefined;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) { executable = candidate; break; }
  }
  const interfaces = physicalInterfaces();
  const requested = process.env.SUBBOOST_TEST_INTERFACE;
  const interfaceName = requested && interfaces.includes(requested) ? requested : !requested && interfaces.length === 1 ? interfaces[0] : undefined;
  return {
    executable, interfaceName,
    available: Boolean(executable && interfaceName),
    message: !executable ? "本机尚未配置检测核心，请按使用说明指定已安装的 Mihomo 程序。" : !interfaceName ? "未能唯一确定联网物理网卡，请按使用说明选择本机检测网卡。" : undefined,
  };
}

/** Never inherit a user's Clash configuration, listeners, controllers, providers or routing. */
export function isolatedProbeConfig(nodes: ParsedNode[], apiPort: number, secret: string, interfaceName: string, savedConfig?: Record<string, unknown>) {
  let network: Record<string, unknown> = {};
  if (savedConfig) {
    const base = typeof savedConfig.dnsYaml === "string" && savedConfig.dnsYaml.trim() ? loadMihomoYaml(savedConfig.dnsYaml) as Record<string, unknown> : {};
    const merged = applySourceDnsDependencies({ dns: DEFAULT_DNS_CONFIG, ...base }, Array.isArray(savedConfig.sources) ? savedConfig.sources as SourceDnsCarrier[] : [], nodes);
    const dns = merged.dns as Record<string, unknown>;
    const scopePolicy = (value: unknown) => value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => nodes.some((node) => typeof node.server === "string" && dnsPatternMatches(key, node.server)))) : {};
    const { "fake-ip-filter": _filter, "fake-ip-filter-mode": _filterMode, ...rest } = dns;
    network = {
      ...(merged.hosts ? { hosts: merged.hosts } : {}),
      dns: {
        ...rest, enable: true, listen: "127.0.0.1:0", ipv6: false, "enhanced-mode": "redir-host", "respect-rules": false,
        "nameserver-policy": scopePolicy(dns["nameserver-policy"]),
        "proxy-server-nameserver-policy": scopePolicy(dns["proxy-server-nameserver-policy"]),
        "fallback-filter": { geoip: false },
      },
    };
  }
  return {
    port: 0, "socks-port": 0, "mixed-port": 0, "redir-port": 0, "tproxy-port": 0,
    "allow-lan": false, "bind-address": "127.0.0.1", mode: "rule", ipv6: false,
    "log-level": "silent", tun: { enable: false, "auto-route": false }, dns: { enable: false },
    ...network,
    "external-controller": `127.0.0.1:${apiPort}`, secret,
    "interface-name": interfaceName, "geo-auto-update": false,
    profile: { "store-selected": false, "store-fake-ip": false },
    proxies: nodes.map((node) => {
      const sanitized = sanitizeMihomoProxyNode(node);
      // Per-node network bindings must not override the isolated physical interface.
      delete sanitized["interface-name"];
      delete sanitized["routing-mark"];
      return sanitized;
    }),
    "proxy-groups": [], listeners: [], rules: ["MATCH,REJECT"],
  };
}

async function reserveApiPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function coreRequest(port: number, secret: string, endpoint: string, signal: AbortSignal, timeout = 1000): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: endpoint, signal, headers: { Authorization: `Bearer ${secret}` }, timeout }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 16384) response.destroy(); });
      response.once("error", reject);
      response.once("end", () => { try { resolve({ status: response.statusCode ?? 500, body: JSON.parse(body) }); } catch { reject(new Error("INVALID_RESPONSE")); } });
    });
    request.once("timeout", () => request.destroy(new Error("TIMEOUT")));
    request.once("error", reject);
  });
}

async function stopCore(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exited, pause(2000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
}

async function runTests(job: Job, selected: { id: string; node: ParsedNode }[], engine: Awaited<ReturnType<typeof nodeTestEngine>>, savedConfig?: Record<string, unknown>) {
  const { signal } = job.controller;
  const temporaryRoot = path.resolve(process.env.SUBBOOST_PROJECT_ROOT || path.resolve(process.cwd(), ".."), "data/node-tests");
  let directory: string | undefined, child: ChildProcess | undefined;
  const deadline = setTimeout(() => job.controller.abort(), 5 * 60_000);
  deadline.unref();
  try {
    const valid = selected.filter(({ id, node }) => {
      const result = job.public.results.find((row) => row.id === id)!;
      if (!isMihomoSupportedProxyNode(sanitizeMihomoProxyNode(node)) || ["relay", "direct", "reject", "dns", "ssh"].includes(node.type) || node["dialer-proxy"]) {
        result.status = "unsupported";
        result.message = "该节点协议或中转依赖暂不支持独立检测";
        return false;
      }
      return true;
    });
    if (!valid.length || signal.aborted) return;
    await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(path.join(temporaryRoot, "subboost-node-test-"));
    const apiPort = await reserveApiPort(), secret = randomBytes(32).toString("hex");
    const file = path.join(directory, "config.yaml");
    // JSON is a YAML subset. The temporary file is removed after every task, including cancellation.
    await fs.writeFile(file, JSON.stringify(isolatedProbeConfig(valid.map(({ id, node }) => ({ ...node, name: id })), apiPort, secret, engine.interfaceName!, savedConfig)), { mode: 0o600 });
    child = spawn(engine.executable!, ["-d", directory, "-f", file], { windowsHide: true, stdio: "ignore", env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" } });
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("exit", () => { failed = true; });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !signal.aborted && !failed; attempt++) {
      if ((await coreRequest(apiPort, secret, "/version", signal, 400).catch(() => null))?.status === 200) { ready = true; break; }
      await pause(100);
    }
    if (!ready) throw new Error("CORE_NOT_READY");
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, valid.length) }, async () => {
      while (cursor < valid.length && !signal.aborted) {
        const item = valid[cursor++], result = job.public.results.find((row) => row.id === item.id)!;
        result.status = "testing";
        try {
          const response = await coreRequest(apiPort, secret, `/proxies/${encodeURIComponent(item.id)}/delay?url=${encodeURIComponent(NODE_TEST_URL)}&timeout=${NODE_TEST_TIMEOUT}&expected=204`, signal, NODE_TEST_TIMEOUT + 1500);
          if (response.status === 200 && typeof response.body.delay === "number") {
            result.status = "available"; result.delay = response.body.delay;
          } else {
            result.status = /timeout|deadline/i.test(String(response.body.message ?? "")) ? "timeout" : "failed";
            result.message = result.status === "timeout" ? "请求超时" : "无法通过该节点访问检测地址";
          }
        } catch (error) {
          result.status = signal.aborted ? "cancelled" : error instanceof Error && /TIMEOUT/.test(error.message) ? "timeout" : "failed";
          result.message = signal.aborted ? "已取消" : "连接失败或检测核心已停止";
        }
        result.checkedAt = new Date().toISOString();
      }
    }));
  } catch {
    for (const result of job.public.results) if (["queued", "testing"].includes(result.status)) {
      result.status = signal.aborted ? "cancelled" : "failed";
      result.message = signal.aborted ? "已取消" : "独立检测进程未能启动，请检查检测核心及节点参数";
    }
  } finally {
    clearTimeout(deadline);
    if (child) await stopCore(child);
    if (directory && path.dirname(directory) === temporaryRoot && path.basename(directory).startsWith("subboost-node-test-")) await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
    for (const result of job.public.results) if (["queued", "testing"].includes(result.status)) result.status = "cancelled";
    job.public.status = signal.aborted ? "cancelled" : "finished";
    job.expires = Date.now() + 30 * 60_000;
  }
}

export async function startNodeTests(ownerId: string, subscriptionId: string, nodes: ParsedNode[], nodeIds: unknown, savedConfig?: Record<string, unknown>): Promise<NodeTestJob> {
  if (!Array.isArray(nodeIds) || !nodeIds.length || nodeIds.length > NODE_TEST_BATCH_LIMIT || nodeIds.some((id) => typeof id !== "string" || !/^node-(0|[1-9]\d*)$/.test(id)) || new Set(nodeIds).size !== nodeIds.length) throw new MaintenanceError(`请选择 1–${NODE_TEST_BATCH_LIMIT} 个不同节点`);
  const selected = nodeIds.map((id: string) => ({ id, node: nodes[Number(id.slice(5))] }));
  if (selected.some(({ node }) => !node)) throw new MaintenanceError("所选节点不存在，请刷新列表", 409);
  for (const [id, job] of jobs) if (job.expires < Date.now() && job.public.status !== "running") jobs.delete(id);
  if ([...jobs.values()].some((job) => job.public.status === "running")) throw new MaintenanceError("已有检测任务正在运行，请先停止或等待完成", 409);
  const engine = await nodeTestEngine();
  if (!engine.available) throw new MaintenanceError(engine.message!, 503);
  // Recheck after asynchronous discovery to prevent concurrent jobs racing through the first check.
  if ([...jobs.values()].some((job) => job.public.status === "running")) throw new MaintenanceError("已有检测任务正在运行", 409);
  const id = randomUUID();
  const job: Job = { ownerId, subscriptionId, controller: new AbortController(), expires: Date.now() + 10 * 60_000,
    public: { id, status: "running", createdAt: new Date().toISOString(), testUrl: NODE_TEST_URL, results: selected.map(({ id, node }): NodeTestResult => ({ id, name: node.name, status: "queued" })) } };
  jobs.set(id, job);
  void runTests(job, selected, engine, savedConfig);
  return structuredClone(job.public);
}

export function nodeTestJob(ownerId: string, subscriptionId: string, id: string, cancel = false): NodeTestJob {
  const job = jobs.get(id);
  if (!job || job.ownerId !== ownerId || job.subscriptionId !== subscriptionId) throw new MaintenanceError("检测任务不存在", 404);
  if (cancel && job.public.status === "running") job.controller.abort();
  return structuredClone(job.public);
}
