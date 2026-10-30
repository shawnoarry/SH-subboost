import { beforeEach, describe, expect, it, vi } from "vitest";
import { isMaintenanceRequestOrigin, maintenanceGetResponse, maintenancePostResponse } from "./maintenance-route-handler";

const mocks = vi.hoisted(() => ({ guard: vi.fn(), subscription: vi.fn(), check: vi.fn(), apply: vi.fn(), nodes: vi.fn(), start: vi.fn(), job: vi.fn() }));
vi.mock("./api-auth", () => ({ withCurrentAdmin: mocks.guard }));
vi.mock("./subscription-service", () => ({ readSubscriptionSecrets: () => ({ nodes: [], config: {} }) }));
vi.mock("./subscription-maintenance", () => ({
  maintenanceSubscription: mocks.subscription, checkSubscriptionUpdate: mocks.check, applySubscriptionUpdate: mocks.apply,
  maintenanceTestContext: mocks.nodes, latestUpdatePreview: () => undefined, subscriptionVersion: () => "version",
  MaintenanceError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock("./node-testing", () => ({ nodeTestEngine: async () => ({ executable: "private-local-path", available: true, interfaceName: "WLAN" }), startNodeTests: mocks.start, nodeTestJob: mocks.job }));
const request = (body: unknown, origin = "http://127.0.0.1:3001") => new Request("http://127.0.0.1:3001/api/subscriptions/sub/maintenance", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockImplementation((handler) => handler({ id: "owner", username: "local" }));
  mocks.subscription.mockResolvedValue({ id: "sub", name: "test", autoUpdateInterval: null });
});
describe("maintenance API access boundaries", () => {
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
