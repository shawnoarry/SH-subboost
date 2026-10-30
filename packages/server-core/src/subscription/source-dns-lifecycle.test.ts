import { describe, expect, it, vi } from "vitest";
import { refreshNodeSnapshot } from "./refresh-node-snapshot";
import { importSubscriptionFromUrl } from "./source-import";
import { normalizeSubscriptionConfigForPersistence } from "./crud";
import type { ParsedNode } from "@subboost/core/types/node";

const node: ParsedNode = { name: "node", type: "trojan", server: "edge.provider.example", port: 443, password: "fixture-only", _sourceIds: ["s1"] };
const dnsDependencies = { policies: { "*.provider.example": ["https://dns.provider.example/dns-query"] }, hosts: { "dns.provider.example": ["203.0.113.4"] } };
const content = `proxies:\n- {name: node, type: trojan, server: edge.provider.example, port: 443, password: fixture-only}\n`;
const richContent = content + `dns:\n  nameserver-policy:\n    '*.provider.example': [https://dns.provider.example/dns-query]\nhosts:\n  dns.provider.example: [203.0.113.4]\n`;
const source = { id: "s1", type: "url", content: "https://provider.example/sub", lastParsedContent: "https://provider.example/sub", dnsDependencies };

describe("source DNS persistence through import and refresh", () => {
  it("prefers a DNS-complete response when user agents return equivalent nodes", async () => {
    const result = await importSubscriptionFromUrl({ url: source.content }, { userAgents: ["plain", "clash"], fetchText: async (request) => ({ ok: true, content: request.userAgent === "clash" ? richContent : content }) });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.content).toBe(richContent); expect(result.dnsDependencies).toEqual(dnsDependencies); }
  });
  it("retains endpoint DNS when a later URL response omits global configuration or a fetch fails", async () => {
    for (const fetched of [{ ok: true, nodes: [node] }, { ok: false, nodes: [] }]) {
      const snapshot = await refreshNodeSnapshot({ config: { sources: [source] }, urls: [], storedNodes: [node], fetchUrlNodes: async () => fetched });
      expect(snapshot.savedSources[0].dnsDependencies).toEqual(dnsDependencies);
    }
  });
  it("updates resolver metadata independently of node changes and permits explicit clearing", async () => {
    for (const next of [{ policies: { "*.provider.example": ["https://new.provider.example/dns-query"] }, hosts: {} }, { policies: {}, hosts: {} }]) {
      const snapshot = await refreshNodeSnapshot({ config: { sources: [source] }, urls: [], storedNodes: [node], fetchUrlNodes: async () => ({ ok: true, nodes: [node], dnsDependencies: next }) });
      expect(snapshot.savedSources[0].dnsDependencies).toEqual(next);
      expect(snapshot.nodes).toHaveLength(1);
    }
  });
  it("does not carry dependencies across source URL changes", async () => {
    const snapshot = await refreshNodeSnapshot({ config: { sources: [{ ...source, content: "https://new.example/sub" }] }, urls: [], storedNodes: [node], fetchUrlNodes: async () => ({ ok: true, nodes: [node] }) });
    expect(snapshot.savedSources[0].dnsDependencies).toBeUndefined();
  });
  it("extracts dependencies from a newly imported static YAML source", async () => {
    const snapshot = await refreshNodeSnapshot({ config: { sources: [{ id: "s1", type: "yaml", content: richContent }] }, urls: [], storedNodes: [], fetchUrlNodes: vi.fn() });
    expect(snapshot.savedSources[0].dnsDependencies).toEqual(dnsDependencies);
  });
  it("preserves metadata from older editors while removing it if the source is replaced or explicitly cleared", () => {
    const existingConfig = { sources: [source] };
    const incoming = { id: "s1", type: "url", content: source.content };
    const normalize = (value: unknown) => normalizeSubscriptionConfigForPersistence({ config: { sources: [value] } }, { existingConfig, mergeExistingConfig: false }).sources as (typeof source)[];
    expect(normalize(incoming)[0].dnsDependencies).toEqual(dnsDependencies);
    expect(normalize({ ...incoming, content: "https://replacement.example/sub" })[0].dnsDependencies).toBeUndefined();
    expect(normalize({ ...incoming, dnsDependencies: { policies: {}, hosts: {} } })[0].dnsDependencies).toEqual({ policies: {}, hosts: {} });
  });
});
