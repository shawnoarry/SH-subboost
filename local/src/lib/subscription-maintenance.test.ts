import { beforeEach, describe, expect, it, vi } from "vitest";
import { applySubscriptionUpdate, checkSubscriptionUpdate, maintenanceTestNodes, subscriptionVersion } from "./subscription-maintenance";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), refresh: vi.fn(), prepare: vi.fn(), persist: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { subscription: { findFirst: mocks.findFirst } } }));
vi.mock("./crypto", () => ({ encryptJson: (value: unknown) => JSON.stringify(value), decryptJson: (value: string) => JSON.parse(value) }));
vi.mock("@subboost/server-core/subscription", () => ({ refreshNodeSnapshot: mocks.refresh, prepareRefreshCacheResult: mocks.prepare }));
vi.mock("./subscription-service", () => ({
  MAX_NODES_PER_SUBSCRIPTION: 10000,
  buildSubscriptionFetchCallbacks: () => ({}),
  readSubscriptionSecrets: () => ({ urls: ["https://example.com/?token=secret-link"], nodes: [{ name: "old", type: "ss", server: "example.com", port: 443, password: "secret-old" }], config: { customRules: [{ value: "direct.example" }] } }),
  persistRefreshSuccess: mocks.persist,
}));
let fixture: { id: string; ownerId: string; encryptedConfig: string; encryptedNodes: string; encryptedUrls: string; updatedAt: Date; autoUpdateInterval: number | null };

beforeEach(() => {
  vi.useRealTimers(); vi.clearAllMocks();
  fixture = { id: crypto.randomUUID(), ownerId: "owner", encryptedConfig: "encrypted-config", encryptedNodes: "encrypted-nodes", encryptedUrls: "encrypted-urls", updatedAt: new Date(), autoUpdateInterval: null };
  mocks.findFirst.mockImplementation(async ({ where }) => where.ownerId === "owner" ? { ...fixture } : null);
  mocks.refresh.mockResolvedValue({ nodes: [{ name: "old", type: "ss", server: "example.com", port: 443, password: "secret-new" }], savedSources: [{ id: "s1", type: "url", content: "https://example.com/?token=secret-link" }], failedSources: [], failedSourceCount: 0, subscriptionInfo: {} });
  mocks.prepare.mockReturnValue({ ok: true, refreshedConfig: { customRules: [{ value: "direct.example" }] } });
  mocks.persist.mockResolvedValue(true);
});

describe("check, preview and confirm update", () => {
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
