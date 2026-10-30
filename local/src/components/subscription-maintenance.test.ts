// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceState, NodeTestJob, UpdatePreview } from "@subboost/core/subscription/maintenance";
import { SubscriptionMaintenance } from "./subscription-maintenance";

const confirm = vi.hoisted(() => vi.fn());
vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({ confirmDialog: confirm }));
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const node = (i: number) => ({ id: `node-${i}`, name: `Node ${i}`, type: i ? "trojan" : "vless", source: "Test source" });
const preview = (): UpdatePreview => ({ id: "preview/1", baseVersion: "v1", checkedAt: "2026-10-30T00:00:00Z", expiresAt: "2026-10-30T00:15:00Z", beforeCount: 2, afterCount: 1, unchangedCount: 0, canApply: true, nodes: [node(2)], changes: [
  { kind: "added", name: "New", fields: [] }, { kind: "removed", name: "Old", fields: [] }, { kind: "changed", name: "Changed", fields: ["server"] }, { kind: "renamed", name: "Renamed", previousName: "Previous", fields: ["name"] },
], sources: [{ name: "Good", status: "updated", dnsChanged: true }, { name: "Bad", status: "failed", message: "Unavailable" }, { name: "Provider", status: "delegated" }], message: "Review before applying" });
const initial = (): MaintenanceState => ({ subscription: { id: "s/1", name: "Test subscription", autoUpdateInterval: null }, version: "v1", nodes: [node(0), node(1)], engine: { available: true, interfaceName: "Ethernet", message: "Local engine" } });
const job = (status: NodeTestJob["status"] = "running"): NodeTestJob => ({ id: "job/1", status, createdAt: "2026-10-30T00:00:00Z", testUrl: "https://example.test/204", results: [{ id: "node-0", name: "Node 0", status: status === "running" ? "queued" : status === "cancelled" ? "cancelled" : "available" }] });
let fetchMock: ReturnType<typeof vi.fn>;
let state: MaintenanceState;
const endpoint = "/api/subscriptions/s%2F1/maintenance";
const mount = async () => { const result = render(React.createElement(SubscriptionMaintenance, { subscriptionId: "s/1" })); await screen.findByText("Test subscription · 更新与检测"); return result; };
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const requests = () => fetchMock.mock.calls.filter(([, options]) => options?.method === "POST").map(([, options]) => JSON.parse(options.body));
beforeEach(() => { confirm.mockReset().mockResolvedValue(true); state = initial(); fetchMock = vi.fn().mockImplementation(async () => reply(state)); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("subscription maintenance browser workflow", () => {
  it("loads once without testing or updating nodes and shows login recovery on failure", async () => {
    fetchMock.mockResolvedValue(reply({ error: "Please sign in" }, 401));
    render(React.createElement(SubscriptionMaintenance, { subscriptionId: "s/1" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Please sign in");
    expect(screen.getByRole("link", { name: "前往登录" }).getAttribute("href")).toBe("/login");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { cache: "no-store" });
    expect((screen.getByRole("button", { name: "检查订阅更新" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("previews changes and only applies the captured preview after confirmation", async () => {
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST" ? reply({ preview: preview() }) : reply(state));
    await mount(); click("检查订阅更新");
    await screen.findByText("Review before applying");
    expect(requests()).toEqual([{ action: "check" }]);
    expect(screen.getByText(/Good：获取成功；节点 DNS/)).toBeTruthy();
    expect(screen.getByText("Bad：获取失败；Unavailable")).toBeTruthy();
    expect(screen.getByText("Provider：由 Clash 管理")).toBeTruthy();
    expect(screen.getByText(/Previous → Renamed/)).toBeTruthy();
    expect(screen.getByLabelText("选择 Node 2")).toBeTruthy();
    confirm.mockResolvedValueOnce(false); click("确认应用更新");
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(requests()).toHaveLength(1);
    state = { ...initial(), version: "v2", nodes: [node(2)] };
    click("确认应用更新");
    await screen.findByText(/更新已保存，原订阅链接保持不变/);
    expect(requests()).toEqual([{ action: "check" }, { action: "apply", previewId: "preview/1" }]);
    expect(screen.queryByText("更新预览 · 尚未应用")).toBeNull();
  });

  it("blocks unsafe previews and distinguishes unchanged content from fetch failures", async () => {
    state.preview = { ...preview(), canApply: false, changes: [], sources: [], message: undefined };
    await mount();
    expect(screen.getByText(/节点内容没有变化/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "确认应用更新" }) as HTMLButtonElement).disabled).toBe(true);
    click(/候选节点/); expect(screen.getByLabelText("选择 Node 2")).toBeTruthy();
    click(/已保存节点/); expect(screen.getByLabelText("选择 Node 0")).toBeTruthy();
  });

  it("switches automatic updates to explicit confirmation through the subscription API", async () => {
    state.subscription.autoUpdateInterval = 3600;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") { state.subscription.autoUpdateInterval = null; return reply({}); }
      return reply(state);
    });
    await mount();
    expect((screen.getByRole("button", { name: "检查订阅更新" }) as HTMLButtonElement).disabled).toBe(true);
    click("改为确认后更新");
    await screen.findByText(/已关闭此订阅的自动更新/);
    expect(fetchMock).toHaveBeenCalledWith("/api/subscriptions/s%2F1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ autoUpdateInterval: null }) }));
    expect((screen.getByRole("button", { name: "检查订阅更新" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("filters names, protocols and sources, toggles selection, and caps bulk selection at 200", async () => {
    state.nodes = Array.from({ length: 203 }, (_, i) => node(i));
    await mount();
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "VLESS" } });
    click("选择当前结果（最多 200）");
    expect(screen.getByRole("button", { name: "检测已选 (1)" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText("选择 Node 0"));
    expect((screen.getByRole("button", { name: "检测已选 (0)" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("选择 Node 0"));
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "test source" } });
    click("选择当前结果（最多 200）");
    expect(screen.getByRole("button", { name: "检测已选 (200)" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索节点"), { target: { value: "nonexistent" } });
    expect(screen.getByText(/没有匹配的节点/)).toBeTruthy();
    expect(requests()).toEqual([]);
  });

  it("keeps saved-node and candidate results separate and sends their exact versions", async () => {
    state.preview = preview();
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method !== "POST") return reply(state);
      const body = JSON.parse(options.body);
      return reply({ job: { ...job("finished"), results: body.nodeIds.map((id: string) => ({ id, name: id, status: "available", delay: 23, message: "Connected", checkedAt: "2026-10-30T00:00:00Z" })) } });
    });
    await mount();
    fireEvent.click(screen.getByLabelText("选择 Node 0")); click("检测已选 (1)");
    await screen.findByText("可连接 · 23 ms");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(requests()[0]).toEqual({ action: "start-test", nodeIds: ["node-0"], version: "v1" });
    click(/候选节点/);
    expect(screen.getByText("未检测")).toBeTruthy();
    click("检测");
    await screen.findByText("可连接 · 23 ms");
    expect(requests()[1]).toEqual({ action: "start-test", nodeIds: ["node-2"], version: "v1", previewId: "preview/1" });
    click(/已保存节点/);
    expect(screen.getByText("可连接 · 23 ms")).toBeTruthy();
  });

  it("polls only an active job, cancels it, then stops polling", async () => {
    let cancelled = false;
    fetchMock.mockImplementation(async (url, options) => {
      if (String(url).includes("?job=")) return reply({ job: job(cancelled ? "cancelled" : "running") });
      if (options?.method === "POST") { if (JSON.parse(options.body).action === "cancel-test") cancelled = true; return reply({ job: job() }); }
      return reply(state);
    });
    await mount();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "检测" })[0]); });
    expect(screen.getByText(/检测进行中/)).toBeTruthy();
    expect((screen.getByLabelText("选择 Node 0") as HTMLInputElement).disabled).toBe(true);
    await act(async () => { click("停止检测"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(800); });
    expect(screen.getByText(/检测已停止/)).toBeTruthy();
    expect(requests().at(-1)).toEqual({ action: "cancel-test", jobId: "job/1" });
    const count = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it("aborts an outstanding poll on unmount and ignores its late response", async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (url, options) => {
      if (String(url).includes("?job=")) { signal = options.signal; return new Promise<Response>((resolve) => { finish = resolve; }); }
      return reply(options?.method === "POST" ? { job: job() } : state);
    });
    const view = await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "检测" })[0]);
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount(); expect(signal!.aborted).toBe(true);
    await act(async () => finish(reply({ job: job("finished") })));
  });

  it.each(["check", "apply", "start-test", "cancel-test", "confirmation", "poll"].flatMap((action) => [[action, true], [action, false]] as const))("shows actionable errors for %s (Error object: %s) and releases busy controls", async (action, typedError) => {
    state.preview = preview();
    if (action === "confirmation") state.subscription.autoUpdateInterval = 3600;
    fetchMock.mockImplementation(async (url, options) => {
      const requestAction = options?.method === "POST" ? JSON.parse(options.body).action : options?.method === "PUT" ? "confirmation" : String(url).includes("?job=") ? "poll" : "load";
      if (requestAction === action) throw typedError ? new Error(`${action} failed`) : "untyped failure";
      return reply(requestAction === "start-test" || requestAction === "poll" ? { job: job() } : state);
    });
    await mount();
    if (action === "check") click("检查订阅更新");
    else if (action === "apply") click("确认应用更新");
    else if (action === "confirmation") click("改为确认后更新");
    else {
      fireEvent.click(screen.getAllByRole("button", { name: "检测" })[0]);
      if (action === "cancel-test") { await screen.findByRole("button", { name: "停止检测" }); click("停止检测"); }
    }
    const fallback: Record<string, string> = { check: "检查失败", apply: "应用失败", "start-test": "检测失败", "cancel-test": "取消失败", confirmation: "操作失败", poll: "无法读取检测进度" };
    expect((await screen.findByRole("alert")).textContent).toContain(typedError ? `${action} failed` : fallback[action]);
    expect(within(screen.getByRole("alert")).queryByText("前往登录")).toBeNull();
  });
});
