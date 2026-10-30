import { maintenanceNodeList } from "@subboost/core/subscription/maintenance";
import { withCurrentAdmin } from "./api-auth";
import { apiError, json, jsonBodyError, LOCAL_JSON_BODY_LIMITS, readJsonBody } from "./http";
import { applySubscriptionUpdate, checkSubscriptionUpdate, latestUpdatePreview, maintenanceSubscription, maintenanceTestContext, MaintenanceError, subscriptionVersion } from "./subscription-maintenance";
import { readSubscriptionSecrets } from "./subscription-service";
import { nodeTestEngine, nodeTestJob, startNodeTests } from "./node-testing";

function failure(error: unknown) {
  if (error instanceof MaintenanceError) return json({ error: error.message }, error.status);
  // Upstream import and core errors can contain subscription credentials. Keep them out of responses and logs.
  return apiError("操作失败，请稍后重试；已保存的配置保持不变", "INTERNAL_ERROR", 500);
}

export function isMaintenanceRequestOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const candidate = new URL(origin);
    const targets = [new URL(request.url), ...(process.env.APP_URL ? [new URL(process.env.APP_URL)] : [])];
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return targets.some((target) => candidate.origin === target.origin || (
      loopback.has(candidate.hostname) && loopback.has(target.hostname) &&
      candidate.protocol === target.protocol && candidate.port === target.port
    ));
  } catch { return false; }
}

export function maintenanceGetResponse(request: Request, id: string) {
  return withCurrentAdmin(async (admin) => {
    try {
      const row = await maintenanceSubscription(admin.id, id);
      const jobId = new URL(request.url).searchParams.get("job");
      if (jobId) return json({ job: nodeTestJob(admin.id, id, jobId) });
      const secrets = readSubscriptionSecrets(row), version = subscriptionVersion(row);
      const preview = latestUpdatePreview(admin.id, id);
      const engine = await nodeTestEngine();
      const sources = Array.isArray(secrets.config.sources) ? secrets.config.sources : [];
      return json({
        subscription: { id: row.id, name: row.name, autoUpdateInterval: row.autoUpdateInterval },
        version, nodes: maintenanceNodeList(secrets.nodes, sources),
        preview: preview?.baseVersion === version ? preview : undefined,
        engine: { available: engine.available, interfaceName: engine.interfaceName, message: engine.message },
      });
    } catch (error) { return failure(error); }
  });
}

export function maintenancePostResponse(request: Request, id: string) {
  return withCurrentAdmin(async (admin) => {
    if (!isMaintenanceRequestOrigin(request) || !request.headers.get("content-type")?.startsWith("application/json")) return apiError("请求来源或格式不正确", "FORBIDDEN", 403);
    const parsed = await readJsonBody(request, LOCAL_JSON_BODY_LIMITS.small);
    if (!parsed.ok) return jsonBodyError(parsed);
    const body = parsed.value as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError("请求格式不正确", "BAD_REQUEST", 400);
    try {
      if (body.action === "check") return json({ preview: await checkSubscriptionUpdate(admin.id, id) });
      if (body.action === "apply" && typeof body.previewId === "string") return json(await applySubscriptionUpdate(admin.id, id, body.previewId));
      if (body.action === "start-test" && typeof body.version === "string") {
        const context = await maintenanceTestContext(admin.id, id, body.version, typeof body.previewId === "string" ? body.previewId : undefined);
        return json({ job: await startNodeTests(admin.id, id, context.nodes, body.nodeIds, context.config) }, 202);
      }
      if (body.action === "cancel-test" && typeof body.jobId === "string") {
        await maintenanceSubscription(admin.id, id);
        return json({ job: nodeTestJob(admin.id, id, body.jobId, true) });
      }
      return apiError("操作或参数无效", "BAD_REQUEST", 400);
    } catch (error) { return failure(error); }
  });
}
