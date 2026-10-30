import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMaintenanceRequestOrigin, maintenanceGetResponse, maintenancePostResponse } from "./maintenance-route-handler";
import { MaintenanceError } from "./subscription-maintenance";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), subscription: vi.fn(), check: vi.fn(), apply: vi.fn(), nodes: vi.fn(), start: vi.fn(), job: vi.fn(), preview: vi.fn(), secrets: vi.fn() }));
vi.mock("./api-auth", () => ({ withCurrentAdmin: mocks.guard }));
vi.mock("./subscription-service", () => ({ readSubscriptionSecrets: mocks.secrets }));
vi.mock("./subscription-maintenance", () => ({
  maintenanceSubscription: mocks.subscription, checkSubscriptionUpdate: mocks.check, applySubscriptionUpdate: mocks.apply,
  maintenanceTestContext: mocks.nodes, latestUpdatePreview: mocks.preview, subscriptionVersion: () => "version",
  MaintenanceError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("./node-testing", () => ({ nodeTestEngine: async () => ({ executable: "private-local-path", available: true, interfaceName: "WLAN" }), startNodeTests: mocks.start, nodeTestJob: mocks.job }));
const request = (body: unknown, origin = "http://127.0.0.1:3001") => new Request("http://127.0.0.1:3001/api/subscriptions/sub/maintenance", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockReturnValue(undefined); mocks.secrets.mockReturnValue({ nodes: [], config: {} });
  mocks.guard.mockImplementation((handler) => handler({ id: "owner", username: "local" }));
  mocks.subscription.mockResolvedValue({ id: "sub", name: "test", autoUpdateInterval: null });
});
describe("maintenance API access boundaries", () => {
  it("accepts headerless local reads, rejects invalid content types and malformed JSON bodies", async () => {
    expect(isMaintenanceRequestOrigin(new Request("http://localhost/"))).toBe(true);
    for (const value of [null, [], "text", 1]) expect((await maintenancePostResponse(request(value), "sub")).status).toBe(400);
    const malformed = new Request("http://127.0.0.1:3001/", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect((await maintenancePostResponse(malformed, "sub")).status).toBe(400);
    expect((await maintenancePostResponse(new Request("http://127.0.0.1:3001/", { method: "POST" }), "sub")).status).toBe(403);
    expect((await maintenancePostResponse(request({ action: "cancel-test" }), "sub")).status).toBe(400);
  });
  it("returns only a matching preview and preserves typed access errors", async () => {
    mocks.secrets.mockReturnValue({ nodes: [], config: { sources: [] } });
    mocks.preview.mockReturnValue({ id: "preview", baseVersion: "version" });
    const result = await (await maintenanceGetResponse(new Request("http://localhost/"), "sub")).json();
    expect(result.preview.id).toBe("preview");
    mocks.preview.mockReturnValue({ id: "stale", baseVersion: "old" });
    expect((await (await maintenanceGetResponse(new Request("http://localhost/"), "sub")).json()).preview).toBeUndefined();
    mocks.subscription.mockRejectedValueOnce(new MaintenanceError("Not yours", 404));
    expect((await maintenanceGetResponse(new Request("http://localhost/"), "sub")).status).toBe(404);
  });
  it("scopes polling, candidate tests and cancellation to the authenticated subscription", async () => {
    mocks.job.mockReturnValue({ id: "job" });
    expect((await maintenanceGetResponse(new Request("http://localhost/?job=job"), "sub")).status).toBe(200);
    expect(mocks.job).toHaveBeenCalledWith("owner", "sub", "job");
    expect((await maintenancePostResponse(request({ action: "cancel-test", jobId: "job" }), "sub")).status).toBe(200);
    expect(mocks.job).toHaveBeenCalledWith("owner", "sub", "job", true);
    mocks.nodes.mockResolvedValue({ nodes: [], config: {} }); mocks.start.mockResolvedValue({ id: "new-job" });
    expect((await maintenancePostResponse(request({ action: "start-test", version: "version", previewId: "preview", nodeIds: ["node-0"] }), "sub")).status).toBe(202);
    expect(mocks.nodes).toHaveBeenCalledWith("owner", "sub", "version", "preview");
  });
  it("accepts the configured origin behind a local proxy, without accepting other local ports", () => {
    vi.stubEnv("APP_URL", "http://subboost-test.localhost:3101");
    expect(isMaintenanceRequestOrigin(new Request("http://127.0.0.1:3101/", { headers: { Origin: "http://subboost-test.localhost:3101" } }))).toBe(true);
    expect(isMaintenanceRequestOrigin(new Request("http://127.0.0.1:3101/", { headers: { Origin: "http://localhost:3101" } }))).toBe(true);
    expect(isMaintenanceRequestOrigin(new Request("http://127.0.0.1:3101/", { headers: { Origin: "http://localhost:9000" } }))).toBe(false);
    expect(isMaintenanceRequestOrigin(new Request("http://127.0.0.1:3101/", { headers: { Origin: "null" } }))).toBe(false);
    vi.unstubAllEnvs();
  });
  it("requires authentication before reading or testing nodes", async () => {
    mocks.guard.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    expect((await maintenanceGetResponse(new Request("http://localhost/"), "sub")).status).toBe(401);
    expect((await maintenancePostResponse(request({ action: "check" }), "sub")).status).toBe(401);
    expect(mocks.subscription).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
  });
  it("rejects foreign origins and malformed actions", async () => {
    expect((await maintenancePostResponse(request({ action: "check" }, "https://foreign.example"), "sub")).status).toBe(403);
    expect((await maintenancePostResponse(request({ action: "unknown" }), "sub")).status).toBe(400);
    expect(mocks.check).not.toHaveBeenCalled();
  });
  it("uses the authenticated owner and only applies a submitted preview token", async () => {
    mocks.apply.mockResolvedValue({ applied: true });
    expect((await maintenancePostResponse(request({ action: "apply", ownerId: "other", previewId: "preview" }), "sub")).status).toBe(200);
    expect(mocks.apply).toHaveBeenCalledWith("owner", "sub", "preview");
    expect((await maintenancePostResponse(request({ action: "apply" }), "sub")).status).toBe(400);
  });
  it("passes the saved DNS context to isolated tests without returning it to the client", async () => {
    const config = { sources: [{ id: "source", dnsDependencies: { policies: { "*.provider.example": ["https://dns.provider.example/query?key=fixture-only"] }, hosts: {} } }] };
    mocks.nodes.mockResolvedValue({ nodes: [], config });
    mocks.start.mockResolvedValue({ id: "job", status: "running", results: [] });
    const response = await maintenancePostResponse(request({ action: "start-test", version: "v1", nodeIds: ["node-0"] }), "sub");
    expect(response.status).toBe(202);
    expect(mocks.start).toHaveBeenCalledWith("owner", "sub", [], ["node-0"], config);
    expect(await response.text()).not.toContain("fixture-only");
  });
  it("omits private executable paths and sanitizes unexpected upstream exceptions", async () => {
    const response = await maintenanceGetResponse(new Request("http://localhost/"), "sub");
    expect(await response.text()).not.toContain("private-local-path");
    mocks.check.mockRejectedValue(new Error("https://example.com/?token=private-token"));
    const failed = await maintenancePostResponse(request({ action: "check" }), "sub");
    expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("private-token");
  });
});
