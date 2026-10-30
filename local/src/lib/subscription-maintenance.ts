import { createHash, randomUUID } from "node:crypto";
import { compareMaintenanceNodes, maintenanceNodeList, type UpdatePreview } from "@subboost/core/subscription/maintenance";
import { refreshNodeSnapshot, prepareRefreshCacheResult } from "@subboost/server-core/subscription";
import type { ParsedNode } from "@subboost/core/types/node";
import { stableJsonStringify } from "@subboost/core/node-identity";
import { prisma } from "./prisma";
import { encryptJson, decryptJson } from "./crypto";
import { buildSubscriptionFetchCallbacks, MAX_NODES_PER_SUBSCRIPTION, persistRefreshSuccess, readSubscriptionSecrets, type SubscriptionRow } from "./subscription-service";

const PREVIEW_TTL = 15 * 60_000;
type Pending = { ownerId: string; subscriptionId: string; version: string; updatedAt: string; expires: number; encrypted: string; preview: UpdatePreview; applying?: boolean };
type PreviewStore = { pending: Map<string, Pending>; checking: Set<string> };
const globalStore = globalThis as unknown as { subboostUpdatePreviews?: PreviewStore };
const store = globalStore.subboostUpdatePreviews ??= { pending: new Map(), checking: new Set() };

export class MaintenanceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function subscriptionVersion(row: Pick<SubscriptionRow, "encryptedConfig" | "encryptedNodes" | "encryptedUrls" | "updatedAt">): string {
  return createHash("sha256").update(JSON.stringify([row.encryptedConfig, row.encryptedNodes, row.encryptedUrls, row.updatedAt.toISOString()])).digest("hex");
}

export async function maintenanceSubscription(ownerId: string, id: string) {
  const row = await prisma.subscription.findFirst({ where: { id, ownerId }, include: { autoUpdateState: true } });
  if (!row) throw new MaintenanceError("订阅不存在或无权访问", 404);
  return row;
}

function expirePreviews() {
  for (const [id, entry] of store.pending) if (entry.expires <= Date.now() && !entry.applying) store.pending.delete(id);
}

export function latestUpdatePreview(ownerId: string, subscriptionId: string): UpdatePreview | undefined {
  expirePreviews();
  return [...store.pending.values()].find((entry) => entry.ownerId === ownerId && entry.subscriptionId === subscriptionId)?.preview;
}

export async function checkSubscriptionUpdate(ownerId: string, id: string): Promise<UpdatePreview> {
  const key = `${ownerId}:${id}`;
  if (store.checking.has(key)) throw new MaintenanceError("正在检查这个订阅，请稍候", 409);
  store.checking.add(key);
  try {
    const row = await maintenanceSubscription(ownerId, id);
    if (row.autoUpdateInterval) throw new MaintenanceError("请先关闭此订阅的自动更新，再使用预览确认模式", 409);
    const secrets = readSubscriptionSecrets(row);
    const snapshot = await refreshNodeSnapshot({ config: secrets.config, urls: secrets.urls, storedNodes: secrets.nodes, ...buildSubscriptionFetchCallbacks() });
    const prepared = prepareRefreshCacheResult({ config: secrets.config, snapshot, maxNodesPerSubscription: MAX_NODES_PER_SUBSCRIPTION });
    const current = await maintenanceSubscription(ownerId, id);
    if (subscriptionVersion(current) !== subscriptionVersion(row)) throw new MaintenanceError("配置在检查期间发生了变化，请重新检查", 409);
    expirePreviews();
    for (const [token, entry] of store.pending) if (entry.ownerId === ownerId && entry.subscriptionId === id && !entry.applying) store.pending.delete(token);
    if (store.pending.size >= 32) throw new MaintenanceError("待确认预览过多，请稍后重试", 429);
    const previewId = randomUUID(), now = Date.now();
    const failed = new Map(snapshot.failedSources.map((source) => [source.id, source]));
    const preview: UpdatePreview = {
      id: previewId, baseVersion: subscriptionVersion(row), checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + PREVIEW_TTL).toISOString(),
      beforeCount: secrets.nodes.length, afterCount: snapshot.nodes.length, ...compareMaintenanceNodes(secrets.nodes, snapshot.nodes),
      sources: snapshot.savedSources.map((source, index) => ({
        name: source.tag || `订阅源 ${index + 1}`,
        dnsChanged: stableJsonStringify(source.dnsDependencies) !== stableJsonStringify((Array.isArray(secrets.config.sources) ? secrets.config.sources : []).find((old) => old.id === source.id)?.dnsDependencies),
        status: failed.has(source.id) ? "failed" as const : source.useProxyProviders ? "delegated" as const : "updated" as const,
        message: failed.has(source.id) ? "获取失败，本次保留该源原有节点" : source.useProxyProviders ? "由 Clash 管理的订阅源，不在这里展开节点" : undefined,
      })),
      canApply: prepared.ok,
      message: !prepared.ok ? (prepared.reason === "all_sources_failed" ? "全部订阅源获取失败，原配置保持不变" : prepared.reason === "empty_result" ? "更新后没有可用节点，不能应用" : "节点数量超过本机上限，不能应用") : snapshot.failedSourceCount ? "部分源失败；确认后仅应用成功源的变化，失败源保留旧节点。" : undefined,
      nodes: maintenanceNodeList(snapshot.nodes, snapshot.savedSources),
    };
    store.pending.set(previewId, {
      ownerId, subscriptionId: id, version: subscriptionVersion(row), updatedAt: row.updatedAt.toISOString(), expires: now + PREVIEW_TTL, preview,
      encrypted: encryptJson({ snapshot: { ...snapshot, renameMap: undefined }, config: prepared.ok ? prepared.refreshedConfig : secrets.config }),
    });
    return preview;
  } finally { store.checking.delete(key); }
}

function pendingPreview(ownerId: string, id: string, previewId: string) {
  expirePreviews();
  const entry = store.pending.get(previewId);
  if (!entry || entry.ownerId !== ownerId || entry.subscriptionId !== id) throw new MaintenanceError("预览已过期或不存在，请重新检查", 409);
  return entry;
}

export async function applySubscriptionUpdate(ownerId: string, id: string, previewId: string) {
  const entry = pendingPreview(ownerId, id, previewId);
  if (!entry.preview.canApply) throw new MaintenanceError("这个预览不能应用，请重新检查", 409);
  if (entry.applying) throw new MaintenanceError("正在应用，请勿重复提交", 409);
  entry.applying = true;
  try {
    const row = await maintenanceSubscription(ownerId, id);
    if (subscriptionVersion(row) !== entry.version || row.autoUpdateInterval) throw new MaintenanceError("订阅已修改，请重新检查后再应用", 409);
    const payload = decryptJson<{ snapshot: Parameters<typeof persistRefreshSuccess>[0]["snapshot"]; config: Record<string, unknown> }>(entry.encrypted, undefined as never);
    const saved = await persistRefreshSuccess({ subscriptionId: id, expectedUpdatedAt: new Date(entry.updatedAt), expectedEncryptedState: { encryptedConfig: row.encryptedConfig, encryptedNodes: row.encryptedNodes, encryptedUrls: row.encryptedUrls }, snapshot: payload.snapshot, config: payload.config, cachedAt: new Date() });
    if (!saved) throw new MaintenanceError("订阅已修改，请重新检查后再应用", 409);
    store.pending.delete(previewId);
    return { applied: true, nodeCount: payload.snapshot.nodes.length };
  } finally { entry.applying = false; }
}

export async function maintenanceTestContext(ownerId: string, id: string, version: string, previewId?: string): Promise<{ nodes: ParsedNode[]; config: Record<string, unknown> }> {
  const row = await maintenanceSubscription(ownerId, id);
  if (previewId) {
    const entry = pendingPreview(ownerId, id, previewId);
    if (subscriptionVersion(row) !== entry.version || version !== entry.version) throw new MaintenanceError("预览已失效，请重新检查", 409);
    const payload = decryptJson<{ snapshot: { nodes: ParsedNode[] }; config: Record<string, unknown> }>(entry.encrypted, undefined as never);
    return { nodes: payload.snapshot.nodes, config: payload.config };
  }
  if (subscriptionVersion(row) !== version) throw new MaintenanceError("节点列表已变化，请重新加载后检测", 409);
  const secrets = readSubscriptionSecrets(row);
  return { nodes: secrets.nodes, config: secrets.config };
}

export async function maintenanceTestNodes(ownerId: string, id: string, version: string, previewId?: string): Promise<ParsedNode[]> {
  return (await maintenanceTestContext(ownerId, id, version, previewId)).nodes;
}
