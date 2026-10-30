import { loadMihomoYaml } from "../config/yaml-schema";
import type { ParsedNode } from "../types/node";
import { stableJsonStringify } from "../node-identity";

export type SourceDnsDependencies = { policies: Record<string, string[]>; hosts: Record<string, string[]> };
export type SourceDnsCarrier = { id?: string; dnsDependencies?: unknown };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const host = (value: unknown): string => typeof value === "string" && value.length <= 253 && /^[a-z\d][a-z\d._:-]*\.?$/i.test(value) ? value.toLowerCase().replace(/\.$/, "") : "";
const pattern = (value: string) => value === "*" ? value : value.startsWith("*.") || value.startsWith("+.") ? value.slice(0, 2) + host(value.slice(2)) : host(value);
export function dnsPatternMatches(key: string, domain: string): boolean {
  if (key === "*") return true;
  if (key.startsWith("*.")) return domain.endsWith(key.slice(1));
  if (key.startsWith("+.")) return domain === key.slice(2) || domain.endsWith(key.slice(1));
  return key === domain;
}
function ip(value: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  try { return value.includes(":") && new URL(`http://[${value}]/`).hostname.length > 2; } catch { return false; }
}
function resolver(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\r\n]/.test(value)) return false;
  if (value === "system" || ip(value)) return true;
  const ipv4Port = value.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
  if (ipv4Port) return ip(ipv4Port[1]) && Number(ipv4Port[2]) > 0 && Number(ipv4Port[2]) <= 65535;
  try {
    const url = new URL(value);
    return ["https:", "tls:", "tcp:", "udp:", "quic:", "h3:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && (!url.hash || url.hash.slice(1).split("&").every((part) => /^(?:h3|skip-cert-verify|name-cert-verify|ecs|ecs-override|disable-ipv4|disable-ipv6|disable-qtype-\d+)=[^#\s]*$/i.test(part)));
  } catch { return false; }
}

export function normalizeSourceDnsDependencies(value: unknown): SourceDnsDependencies | undefined {
  if (!record(value) || !record(value.policies) || !record(value.hosts)) return undefined;
  const policies: Record<string, string[]> = {}, hosts: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value.policies).slice(0, 1024)) {
    const normalized = pattern(key);
    const values = Array.isArray(raw) ? raw : [raw];
    if (!normalized || normalized.endsWith(".") || !values.length || values.length > 16 || !values.every(resolver)) continue;
    policies[normalized] = [...new Set(values)];
  }
  for (const [key, raw] of Object.entries(value.hosts).slice(0, 1024)) {
    const normalized = host(key), values = Array.isArray(raw) ? raw : [raw];
    if (!normalized || !normalized.includes(".") || !values.length || values.length > 32 || !values.every((value) => typeof value === "string" && ip(value))) continue;
    hosts[normalized] = [...new Set(values)] as string[];
  }
  return { policies, hosts };
}

export function scopeSourceDnsDependencies(value: unknown, nodes: ParsedNode[]): SourceDnsDependencies | undefined {
  const normalized = normalizeSourceDnsDependencies(value);
  if (!normalized) return undefined;
  const domains = nodes.map((node) => host(node.server)).filter(Boolean);
  const policies = Object.fromEntries(Object.entries(normalized.policies).filter(([key]) => domains.some((domain) => dnsPatternMatches(key, domain))));
  const required = new Set(domains);
  for (const values of Object.values(policies)) for (const value of values) {
    try { required.add(new URL(value).hostname.toLowerCase()); } catch { /* Plain resolver IP. */ }
  }
  return { policies, hosts: Object.fromEntries(Object.entries(normalized.hosts).filter(([name]) => required.has(name))) };
}

/** Import only policies used by proxy endpoint names and hosts used by those endpoints/resolvers. */
export function extractSourceDnsDependencies(content: string, nodes: ParsedNode[]): SourceDnsDependencies | undefined {
  try {
    let text = content.trimStart();
    if (!text.match(/^(?:---|#|\{|[a-zA-Z][\w-]*\s*:)/)) {
      if (!/^[a-z\d+/=_\s-]+$/i.test(text)) return undefined;
      text = new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0)));
    }
    const parsed: unknown = loadMihomoYaml(text);
    if (!record(parsed) || (!record(parsed.dns) && !record(parsed.hosts))) return undefined;
    const dns = record(parsed.dns) ? parsed.dns : {};
    const policies = { ...(record(dns["nameserver-policy"]) ? dns["nameserver-policy"] : {}), ...(record(dns["proxy-server-nameserver-policy"]) ? dns["proxy-server-nameserver-policy"] : {}) };
    return scopeSourceDnsDependencies({ policies, hosts: record(parsed.hosts) ? parsed.hosts : {} }, nodes);
  } catch { return undefined; }
}

export function refreshSourceDnsDependencies(previous: unknown, incoming: unknown, nodes: ParsedNode[], reset = false): SourceDnsDependencies | undefined {
  return scopeSourceDnsDependencies(incoming ?? (reset ? undefined : previous), nodes);
}

/** User policies win. Inherited wildcard policies are narrowed to the source's actual endpoint names. */
export function applySourceDnsDependencies(base: Record<string, unknown>, sources: readonly SourceDnsCarrier[], nodes: ParsedNode[]): Record<string, unknown> {
  const dns = record(base.dns) ? base.dns : {};
  const manual = record(dns["nameserver-policy"]) ? dns["nameserver-policy"] : {};
  const manualProxy = record(dns["proxy-server-nameserver-policy"]) ? dns["proxy-server-nameserver-policy"] : {};
  const policies: Record<string, string[]> = {}, hosts: Record<string, string[]> = {};
  const put = (target: Record<string, string[]>, name: string, values: string[]) => {
    if (target[name] && stableJsonStringify(target[name]) !== stableJsonStringify(values)) throw new Error("多个订阅源的节点 DNS 依赖冲突，请在基础和 DNS 配置中明确指定解析策略");
    target[name] = values;
  };
  for (const source of sources) {
    const sourceNodes = source.id ? nodes.filter((node) => (node as ParsedNode & { _sourceIds?: string[] })._sourceIds?.includes(source.id!)) : nodes;
    const dependencies = scopeSourceDnsDependencies(source.dnsDependencies, sourceNodes);
    if (!dependencies) continue;
    for (const node of sourceNodes) {
      const domain = host(node.server);
      if (!domain || Object.keys(manual).some((key) => dnsPatternMatches(key.toLowerCase(), domain))) continue;
      const selected = Object.keys(dependencies.policies).filter((key) => dnsPatternMatches(key, domain)).sort((a, b) => (a === domain ? -1 : b === domain ? 1 : b.length - a.length))[0];
      if (selected) put(policies, domain, dependencies.policies[selected]);
    }
    for (const [name, values] of Object.entries(dependencies.hosts)) {
      if (record(base.hosts) && Object.hasOwn(base.hosts, name)) continue;
      put(hosts, name, values);
    }
  }
  if (!Object.keys(policies).length && !Object.keys(hosts).length) return base;
  if (base.dns !== undefined && !record(base.dns)) throw new Error("节点 DNS 依赖需要 dns 为对象");
  const proxyPolicies = Object.fromEntries(Object.entries(policies).filter(([name]) => !Object.keys(manualProxy).some((key) => dnsPatternMatches(key.toLowerCase(), name))));
  return {
    ...base,
    ...(Object.keys(hosts).length ? { hosts: { ...hosts, ...(record(base.hosts) ? base.hosts : {}) } } : {}),
    dns: {
      ...dns,
      ...(Object.keys(hosts).length && dns["use-hosts"] === undefined ? { "use-hosts": true } : {}),
      ...(Object.keys(policies).length ? { "nameserver-policy": { ...policies, ...manual } } : {}),
      ...(dns["proxy-server-nameserver"] && Object.keys(proxyPolicies).length ? { "proxy-server-nameserver-policy": { ...proxyPolicies, ...manualProxy } } : {}),
    },
  };
}
