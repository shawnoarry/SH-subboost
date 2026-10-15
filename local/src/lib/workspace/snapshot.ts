import { getNodeEndpointError } from "@subboost/core/node-endpoint";
import { parseNodeNameFilterConfig } from "@subboost/core/subscription/node-name-filter";
import { SUBBOOST_TEMPLATE_CONFIG_SCHEMA, validateSubBoostTemplateConfig } from "@subboost/core/templates/config-template";
import type { ConfigState } from "@subboost/ui/store/config-store/definitions";

export const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_ITEMS = 10000;
const FIELDS = [
  "sources", "nodes", "deletedNodeNames", "deletedNodes", "nodeNameFilter", "template",
  "enabledProxyGroups", "hiddenProxyGroups", "customProxyGroups", "proxyGroupAdvanced",
  "proxyGroupAdvancedModeEnabled", "customRuleSets", "builtinRuleEdits", "customRules",
  "dialerProxyGroups", "proxyGroupNameOverrides", "proxyGroupOrder", "ruleOrder", "dnsYaml",
  "mixedPort", "allowLan", "testUrl", "testInterval", "ruleProviderBaseUrl", "cnIpNoResolve",
  "experimentalCnUseCnRuleSet", "listenerPorts", "groupListeners",
] as const satisfies readonly (keyof ConfigState)[];

export type WorkspaceSnapshot = Pick<ConfigState, (typeof FIELDS)[number]>;
export type WorkspaceDocument = {
  schema: "subboost-workspace/v1";
  workspaceId: string;
  revisionId: string;
  ancestors: string[];
  name: string;
  updatedAt: string;
  state: WorkspaceSnapshot;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every((item) => typeof item === "string");
}

function port(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

// A workspace is data only. Reject prototype keys and excessively nested JSON before using it.
function inspectJson(value: unknown, depth = 0): void {
  requireValue(depth <= 32, "工作配置嵌套过深");
  if (Array.isArray(value)) {
    requireValue(value.length <= MAX_ITEMS, "工作配置中的列表过长");
    value.forEach((item) => inspectJson(item, depth + 1));
  } else if (record(value)) {
    const keys = Object.keys(value);
    requireValue(keys.length <= MAX_ITEMS, "工作配置中的对象过大");
    for (const key of keys) {
      requireValue(!["__proto__", "constructor", "prototype"].includes(key), "工作配置含有不安全字段");
      inspectJson(value[key], depth + 1);
    }
  } else {
    requireValue(value === null || ["string", "boolean", "number"].includes(typeof value), "工作配置不是有效 JSON");
    if (typeof value === "number") requireValue(Number.isFinite(value), "工作配置含有无效数值");
  }
}

function checkNode(value: unknown): void {
  requireValue(record(value) && typeof value.name === "string" && value.name.trim() && typeof value.type === "string" && value.type.trim(), "工作配置含有无效节点");
  if (value.type === "relay") {
    requireValue(stringList(value.proxies) && value.proxies.length > 0, "中转节点配置无效");
  } else {
    requireValue(!getNodeEndpointError(value), "工作配置的节点地址或端口无效");
  }
  if (value._sourceIds !== undefined) requireValue(stringList(value._sourceIds), "节点来源标记无效");
  if (value._originName !== undefined) requireValue(typeof value._originName === "string", "节点原名无效");
}

export function captureWorkspace(state: ConfigState): WorkspaceSnapshot {
  const snapshot = Object.fromEntries(FIELDS.map((field) => [field, state[field]])) as WorkspaceSnapshot;
  // Request status, errors and UI history are device-local, never transferred.
  return JSON.parse(JSON.stringify({
    ...snapshot,
    sources: state.sources.map(({ parsing: _parsing, error: _error, errorInfo: _errorInfo, ...source }) => source),
  })) as WorkspaceSnapshot;
}

export function validateWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  requireValue(record(value), "工作配置内容无效");
  inspectJson(value);
  requireValue(FIELDS.every((field) => Object.hasOwn(value, field)), "工作配置不完整，请更新两台电脑上的 SubBoost");
  const template = validateSubBoostTemplateConfig({ ...value, schema: SUBBOOST_TEMPLATE_CONFIG_SCHEMA });
  requireValue(template.ok, template.ok ? "" : `生成设置无效：${template.error}`);
  requireValue(Array.isArray(value.sources) && value.sources.length <= MAX_ITEMS, "订阅源列表无效");
  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    requireValue(record(source) && typeof source.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(source.id) && !sourceIds.has(source.id), "订阅源 ID 无效或重复");
    sourceIds.add(source.id);
    requireValue(["url", "yaml", "nodes"].includes(String(source.type)) && typeof source.content === "string", "订阅源内容无效");
    for (const field of ["name", "lastParsedContent", "lastParsedTag", "lastParsedNameTemplate", "tag", "nameTemplate", "userinfoUrl", "userinfoUserAgent"]) {
      requireValue(source[field] === undefined || typeof source[field] === "string", "订阅源字段无效");
    }
    for (const field of ["useProxyProviders", "parsed"]) requireValue(source[field] === undefined || typeof source[field] === "boolean", "订阅源状态无效");
    requireValue(source.nodeCount === undefined || (typeof source.nodeCount === "number" && Number.isInteger(source.nodeCount) && source.nodeCount >= 0), "订阅源节点数无效");
    requireValue(source.subscriptionUserInfo === undefined || record(source.subscriptionUserInfo), "订阅流量信息无效");
    for (const field of ["content", "userinfoUrl"]) {
      if ((field === "content" && source.type !== "url") || !source[field]) continue;
      let url: URL;
      try { url = new URL(String(source[field])); } catch { throw new Error("工作配置含有无效订阅链接"); }
      requireValue(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, "订阅链接必须使用 HTTP 或 HTTPS，且不能内嵌账号密码");
    }
  }
  requireValue(Array.isArray(value.nodes), "节点列表无效");
  value.nodes.forEach(checkNode);
  const nodeNames = value.nodes.map((node) => (node as { name: string }).name);
  requireValue(new Set(nodeNames).size === nodeNames.length, "节点名称重复");
  requireValue(stringList(value.deletedNodeNames) && Array.isArray(value.deletedNodes), "节点删除记录无效");
  for (const deleted of value.deletedNodes) {
    requireValue(record(deleted) && typeof deleted.originName === "string" && typeof deleted.name === "string", "节点删除记录无效");
    if (deleted.node !== undefined) checkNode(deleted.node);
    if (deleted.listenerPort !== undefined) requireValue(port(deleted.listenerPort), "已删除节点的监听端口无效");
    for (const field of ["dialerRelayGroupIds", "dialerTargetGroupIds"]) requireValue(deleted[field] === undefined || stringList(deleted[field]), "已删除节点的中转关系无效");
  }
  const nodeNameFilter = parseNodeNameFilterConfig(value.nodeNameFilter);
  requireValue(stringList(value.proxyGroupOrder), "代理组顺序无效");
  requireValue(record(value.listenerPorts) && Object.values(value.listenerPorts).every(port), "节点监听端口无效");
  requireValue(Array.isArray(value.groupListeners), "分组监听设置无效");
  for (const listener of value.groupListeners) {
    requireValue(record(listener) && typeof listener.id === "string" && port(listener.port) && record(listener.target) && ["module", "custom", "dialer"].includes(String(listener.target.kind)) && typeof listener.target.id === "string", "分组监听设置无效");
    for (const field of ["enabled", "allowLan"]) requireValue(listener[field] === undefined || typeof listener[field] === "boolean", "分组监听开关无效");
  }
  const out = Object.fromEntries(FIELDS.map((field) => [field, value[field]])) as WorkspaceSnapshot;
  const { schema: _schema, ...settings } = template.config;
  return captureWorkspace({ ...out, ...settings, nodeNameFilter, sources: out.sources.map((source) => ({ ...source, parsing: false })) } as ConfigState);
}

export function validateWorkspaceDocument(value: unknown): WorkspaceDocument {
  requireValue(record(value) && value.schema === "subboost-workspace/v1", "不支持的工作配置版本");
  for (const field of ["workspaceId", "revisionId"]) requireValue(typeof value[field] === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(value[field]), "工作配置版本标识无效");
  requireValue(stringList(value.ancestors) && value.ancestors.length <= 100 && value.ancestors.every((id) => /^[a-zA-Z0-9-]{16,80}$/.test(id)) && !value.ancestors.includes(value.revisionId as string), "工作配置版本记录无效");
  requireValue(typeof value.name === "string" && value.name.trim().length > 0 && value.name.length <= 100, "工作配置名称需为 1–100 个字符");
  requireValue(typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt)), "工作配置更新时间无效");
  return {
    schema: "subboost-workspace/v1", workspaceId: value.workspaceId as string, revisionId: value.revisionId as string,
    ancestors: value.ancestors as string[], name: value.name, updatedAt: value.updatedAt,
    state: validateWorkspaceSnapshot(value.state),
  };
}

export function nextWorkspace(state: WorkspaceSnapshot, name: string, previous?: WorkspaceDocument): WorkspaceDocument {
  return validateWorkspaceDocument({
    schema: "subboost-workspace/v1", workspaceId: previous?.workspaceId ?? crypto.randomUUID(),
    revisionId: crypto.randomUUID(), ancestors: previous ? [previous.revisionId, ...previous.ancestors].slice(0, 100) : [],
    name: name.trim(), updatedAt: new Date().toISOString(), state,
  });
}

export function compareWorkspace(current: WorkspaceDocument, incoming: WorkspaceDocument): "same" | "newer" | "older" | "diverged" | "different" {
  if (current.workspaceId !== incoming.workspaceId) return "different";
  if (current.revisionId === incoming.revisionId) return "same";
  if (incoming.ancestors.includes(current.revisionId)) return "newer";
  if (current.ancestors.includes(incoming.revisionId)) return "older";
  return "diverged";
}
