import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySubscriptionUpdate, checkSubscriptionUpdate, latestUpdatePreview, maintenanceSubscription, maintenanceTestNodes, subscriptionVersion } from "./subscription-maintenance";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), refresh: vi.fn(), prepare: vi.fn(), persist: vi.fn(), secrets: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { subscription: { findFirst: mocks.findFirst } } }));
vi.mock("./crypto", () => ({ encryptJson: (value: unknown) => JSON.stringify(value), decryptJson: (value: string) => JSON.parse(value) }));
vi.mock("@subboost/server-core/subscription", () => ({ refreshNodeSnapshot: mocks.refresh, prepareRefreshCacheResult: mocks.prepare }));
vi.mock("./subscription-service", () => ({
  MAX_NODES_PER_SUBSCRIPTION: 10000,
  buildSubscriptionFetchCallbacks: () => ({}),
  readSubscriptionSecrets: mocks.secrets,
  persistRefreshSuccess: mocks.persist,
}));
let fixture: { id: string; ownerId: string; encryptedConfig: string; encryptedNodes: string; encryptedUrls: string; updatedAt: Date; autoUpdateInterval: number | null };

beforeEach(() => {
  vi.useRealTimers(); vi.clearAllMocks();
  const store = (globalThis as unknown as { subboostUpdatePreviews: { pending: Map<string, unknown>; checking: Set<string> } }).subboostUpdatePreviews;
  store.pending.clear(); store.checking.clear();
  mocks.secrets.mockReturnValue({ urls: ["https://example.com/?token=secret-link"], nodes: [{ name: "old", type: "ss", server: "example.com", port: 443, password: "secret-old" }], config: { customRules: [{ value: "direct.example" }] } });
  fixture = { id: crypto.randomUUID(), ownerId: "owner", encryptedConfig: "encrypted-config", encryptedNodes: "encrypted-nodes", encryptedUrls: "encrypted-urls", updatedAt: new Date(), autoUpdateInterval: null };
  mocks.findFirst.mockImplementation(async ({ where }) => where.ownerId === "owner" ? { ...fixture } : null);
  mocks.refresh.mockResolvedValue({ nodes: [{ name: "old", type: "ss", server: "example.com", port: 443, password: "secret-new" }], savedSources: [{ id: "s1", type: "url", content: "https://example.com/?token=secret-link" }], failedSources: [], failedSourceCount: 0, subscriptionInfo: {} });
  mocks.prepare.mockReturnValue({ ok: true, refreshedConfig: { customRules: [{ value: "direct.example" }] } });
  mocks.persist.mockResolvedValue(true);
});

describe("check, preview and confirm update", () => {
  it("reports unavailable subscriptions and returns saved nodes only for the current version", async () => {
    await expect(maintenanceSubscription("other", fixture.id)).rejects.toThrow("无权访问");
    expect(await maintenanceTestNodes("owner", fixture.id, subscriptionVersion(fixture))).toEqual(mocks.secrets().nodes);
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    expect(latestUpdatePreview("other", fixture.id)).toBeUndefined();
    expect(latestUpdatePreview("owner", "another")).toBeUndefined();
    expect(latestUpdatePreview("owner", fixture.id)?.id).toBe(preview.id);
    await expect(maintenanceTestNodes("owner", fixture.id, "old-version", preview.id)).rejects.toThrow("预览已失效");
    fixture.encryptedNodes = "edited";
    await expect(maintenanceTestNodes("owner", fixture.id, preview.baseVersion, preview.id)).rejects.toThrow("预览已失效");
  });
  it.each(["empty_result", "node_limit_exceeded"])("explains a blocked %s preview without writing it", async (reason) => {
    mocks.prepare.mockReturnValue({ ok: false, reason });
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    expect(preview.canApply).toBe(false);
    expect(preview.message).toContain(reason === "empty_result" ? "没有可用节点" : "超过本机上限");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("shows partial failures, delegated providers and DNS changes without revealing source URLs", async () => {
    const savedSources = [{ id: "bad", tag: "Failed source" }, { id: "provider", useProxyProviders: true }, { id: "good", tag: "Good source", dnsDependencies: { policies: {}, hosts: {} } }];
    mocks.secrets.mockReturnValue({ urls: [], nodes: [], config: { sources: [{ id: "good" }] } });
    mocks.refresh.mockResolvedValue({ nodes: [], savedSources, failedSources: [{ id: "bad" }], failedSourceCount: 1 });
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    expect(preview.sources.map((source) => source.status)).toEqual(["failed", "delegated", "updated"]);
    expect(preview.sources[2].dnsChanged).toBe(true); expect(preview.message).toContain("部分源失败");
  });
  it("replaces superseded previews, limits pending work and releases the checking lock after failure", async () => {
    const old = await checkSubscriptionUpdate("owner", fixture.id);
    const fresh = await checkSubscriptionUpdate("owner", fixture.id);
    await expect(applySubscriptionUpdate("owner", fixture.id, old.id)).rejects.toThrow("过期");
    expect(latestUpdatePreview("owner", fixture.id)?.id).toBe(fresh.id);
    for (let i = 0; i < 31; i++) { fixture.id = `other-${i}`; await checkSubscriptionUpdate("owner", fixture.id); }
    fixture.id = "overflow";
    await expect(checkSubscriptionUpdate("owner", fixture.id)).rejects.toThrow("预览过多");
    await expect(checkSubscriptionUpdate("owner", fixture.id)).rejects.toThrow("预览过多");
  });
  it("rejects overlapping checks and duplicate applies while preserving the active preview", async () => {
    const snapshot = await mocks.refresh();
    let finishRefresh!: (value: unknown) => void;
    mocks.refresh.mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const checking = checkSubscriptionUpdate("owner", fixture.id);
    await vi.waitFor(() => expect(finishRefresh).toBeDefined());
    await expect(checkSubscriptionUpdate("owner", fixture.id)).rejects.toThrow("正在检查");
    finishRefresh(snapshot); const preview = await checking;
    let finishSave!: (value: boolean) => void;
    mocks.persist.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const applying = applySubscriptionUpdate("owner", fixture.id, preview.id);
    await vi.waitFor(() => expect(finishSave).toBeDefined());
    await expect(applySubscriptionUpdate("owner", fixture.id, preview.id)).rejects.toThrow("正在应用");
    await checkSubscriptionUpdate("owner", fixture.id);
    expect(latestUpdatePreview("owner", fixture.id)?.id).toBe(preview.id);
    finishSave(true); await applying;
  });
  it("checking makes no writes, reveals no credentials and applying uses the exact cached candidate", async () => {
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(JSON.stringify(preview)).not.toContain("secret");
    expect(JSON.stringify(preview)).not.toContain("example.com");
    mocks.refresh.mockRejectedValue(new Error("upstream now changed"));
    expect(await applySubscriptionUpdate("owner", fixture.id, preview.id)).toEqual({ applied: true, nodeCount: 1 });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.persist.mock.calls[0][0].snapshot.nodes[0].password).toBe("secret-new");
    expect(mocks.persist.mock.calls[0][0].config.customRules).toEqual([{ value: "direct.example" }]);
    await expect(applySubscriptionUpdate("owner", fixture.id, preview.id)).rejects.toThrow("过期");
  });
  it("blocks a stale preview after editing and an edit during fetching", async () => {
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    fixture.encryptedConfig = "changed";
    await expect(applySubscriptionUpdate("owner", fixture.id, preview.id)).rejects.toThrow("已修改");
    expect(mocks.persist).not.toHaveBeenCalled();
    mocks.refresh.mockImplementationOnce(async () => { fixture.encryptedNodes = "changed-during-fetch"; return { nodes: [], failedSources: [], savedSources: [] }; });
    await expect(checkSubscriptionUpdate("owner", fixture.id)).rejects.toThrow("检查期间");
  });
  it("binds previews and tests to both subscription and owner", async () => {
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    await expect(applySubscriptionUpdate("other", fixture.id, preview.id)).rejects.toThrow("不存在");
    await expect(applySubscriptionUpdate("owner", "other-subscription", preview.id)).rejects.toThrow("不存在");
    await expect(maintenanceTestNodes("owner", fixture.id, "stale-version")).rejects.toThrow("已变化");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("expires previews and refuses to apply all-failed results", async () => {
    vi.useFakeTimers();
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    vi.advanceTimersByTime(16 * 60_000);
    await expect(applySubscriptionUpdate("owner", fixture.id, preview.id)).rejects.toThrow("过期");
    mocks.prepare.mockReturnValue({ ok: false, reason: "all_sources_failed" });
    const failed = await checkSubscriptionUpdate("owner", fixture.id);
    expect(failed.canApply).toBe(false);
    await expect(applySubscriptionUpdate("owner", fixture.id, failed.id)).rejects.toThrow("不能应用");
  });
  it("checks concurrency at commit and requires manual mode", async () => {
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    mocks.persist.mockResolvedValue(false);
    await expect(applySubscriptionUpdate("owner", fixture.id, preview.id)).rejects.toThrow("已修改");
    fixture.autoUpdateInterval = 3600;
    await expect(checkSubscriptionUpdate("owner", fixture.id)).rejects.toThrow("关闭");
  });
  it("tests preview candidates without applying them", async () => {
    const preview = await checkSubscriptionUpdate("owner", fixture.id);
    const nodes = await maintenanceTestNodes("owner", fixture.id, subscriptionVersion(fixture), preview.id);
    expect((nodes[0] as unknown as { password: string }).password).toBe("secret-new");
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
