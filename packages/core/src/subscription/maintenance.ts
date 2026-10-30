import { buildNodeContentKey, stableJsonStringify } from "../node-identity";
import type { ParsedNode } from "../types/node";

export type NodeChange = { kind: "added" | "removed" | "changed" | "renamed"; name: string; previousName?: string; fields: string[] };
export type MaintenanceNode = { id: string; name: string; type: string; source: string };
export type UpdatePreview = {
  id: string; baseVersion: string; checkedAt: string; expiresAt: string;
  beforeCount: number; afterCount: number; changes: NodeChange[]; unchangedCount: number;
  sources: { name: string; status: "updated" | "failed" | "delegated"; message?: string }[];
  canApply: boolean; message?: string; nodes: MaintenanceNode[];
};
export type NodeTestStatus = "queued" | "testing" | "available" | "timeout" | "failed" | "unsupported" | "cancelled";
export type NodeTestResult = { id: string; name: string; status: NodeTestStatus; delay?: number; checkedAt?: string; message?: string };
export type NodeTestJob = { id: string; status: "running" | "finished" | "cancelled"; createdAt: string; testUrl: string; results: NodeTestResult[] };
export type MaintenanceState = {
  subscription: { id: string; name: string; autoUpdateInterval: number | null };
  version: string; nodes: MaintenanceNode[]; preview?: UpdatePreview;
  engine: { available: boolean; interfaceName?: string; message?: string };
};

/** Return field names only. Credentials and subscription URLs never enter a diff. */
export function compareMaintenanceNodes(previous: ParsedNode[], next: ParsedNode[]) {
  const changes: NodeChange[] = [];
  const unused = new Set(next);
  const byName = new Map(next.map((node) => [node.name, node]));
  const byContent = new Map<string, ParsedNode[]>();
  for (const node of next) {
    const key = buildNodeContentKey(node);
    const bucket = byContent.get(key) ?? [];
    bucket.push(node);
    byContent.set(key, bucket);
  }
  let unchangedCount = 0;
  const unmatched: ParsedNode[] = [];
  const compare = (before: ParsedNode, after: ParsedNode) => {
    unused.delete(after);
    const a = JSON.parse(buildNodeContentKey(before)) as Record<string, unknown>;
    const b = JSON.parse(buildNodeContentKey(after)) as Record<string, unknown>;
    const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((key) => stableJsonStringify(a[key]) !== stableJsonStringify(b[key])).sort();
    if (fields.length) changes.push({ kind: "changed", name: after.name, previousName: before.name !== after.name ? before.name : undefined, fields });
    else if (before.name !== after.name) changes.push({ kind: "renamed", name: after.name, previousName: before.name, fields: ["name"] });
    else unchangedCount++;
  };
  // Reserve same-name counterparts before matching renamed endpoints.
  for (const before of previous) {
    const after = byName.get(before.name);
    if (after && unused.has(after)) compare(before, after);
    else unmatched.push(before);
  }
  for (const before of unmatched) {
    const after = byContent.get(buildNodeContentKey(before))?.find((node) => unused.has(node));
    if (after) compare(before, after);
    else changes.push({ kind: "removed", name: before.name, fields: [] });
  }
  for (const after of unused) changes.push({ kind: "added", name: after.name, fields: [] });
  return { changes, unchangedCount };
}

export function maintenanceNodeList(nodes: ParsedNode[], sources: { id: string; name?: string; tag?: string }[] = []): MaintenanceNode[] {
  const labels = new Map(sources.map((source, index) => [source.id, source.name || source.tag || `订阅源 ${index + 1}`]));
  return nodes.map((node, index) => {
    const ids = (node as ParsedNode & { _sourceIds?: string[] })._sourceIds ?? [];
    return { id: `node-${index}`, name: node.name, type: node.type, source: ids.map((id) => labels.get(id) || "订阅源").join("、") || "已保存节点" };
  });
}
