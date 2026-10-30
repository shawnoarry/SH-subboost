import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
import type { ParsedNode } from "../types/node";
import { applySourceDnsDependencies, extractSourceDnsDependencies, normalizeSourceDnsDependencies, refreshSourceDnsDependencies } from "./source-dns";
import { generateClashConfig } from "../generator";

const node = (server = "entry.provider.example", source = "one"): ParsedNode => ({ name: server, type: "trojan", server, port: 443, password: "test-only", _sourceIds: [source] });
const dependencies = { policies: { "*.provider.example": ["https://resolver.provider.example/dns-query"] }, hosts: { "resolver.provider.example": ["203.0.113.3"] } };
const input = yaml.dump({ proxies: [node()], dns: { "nameserver-policy": { ...dependencies.policies, "geosite:cn": ["223.5.5.5"], "unrelated.example": ["1.1.1.1"] } }, hosts: { ...dependencies.hosts, "unrelated.example": ["203.0.113.8"] }, tun: { enable: true }, secret: "never-import-this" });
describe("source DNS compatibility", () => {
  it("extracts only endpoint DNS policies and necessary bootstrap hosts from YAML and base64 YAML", () => {
    expect(extractSourceDnsDependencies(input, [node()])).toEqual(dependencies);
    expect(extractSourceDnsDependencies("---\n" + input, [node()])).toEqual(dependencies);
    expect(extractSourceDnsDependencies(Buffer.from(input).toString("base64"), [node()])).toEqual(dependencies);
    expect(JSON.stringify(extractSourceDnsDependencies(input, [node()]))).not.toContain("never-import-this");
    expect(extractSourceDnsDependencies("trojan://test@node.example:443", [node()])).toBeUndefined();
  });
  it("retains dependencies when a refresh returns only nodes, but prunes stale endpoints and resets changed sources", () => {
    expect(refreshSourceDnsDependencies(dependencies, undefined, [node()])).toEqual(dependencies);
    expect(refreshSourceDnsDependencies(dependencies, undefined, [node("elsewhere.example")])).toEqual({ policies: {}, hosts: {} });
    expect(refreshSourceDnsDependencies(dependencies, undefined, [node()], true)).toBeUndefined();
    expect(refreshSourceDnsDependencies(dependencies, { policies: {}, hosts: {} }, [node()])).toEqual({ policies: {}, hosts: {} });
  });
  it("scopes inherited wildcard policies to the relevant source's actual endpoint names", () => {
    const base = { dns: { nameserver: ["223.5.5.5"] }, tun: { enable: false } };
    const generated = applySourceDnsDependencies(base, [{ id: "one", dnsDependencies: dependencies }], [node(), node("other.provider.example", "two")]);
    expect(generated.dns).toMatchObject({ "nameserver-policy": { "entry.provider.example": dependencies.policies["*.provider.example"] } });
    expect((generated.dns as Record<string, unknown>)["nameserver-policy"]).not.toHaveProperty("other.provider.example");
    expect(base).toEqual({ dns: { nameserver: ["223.5.5.5"] }, tun: { enable: false } });
    expect(applySourceDnsDependencies(base, [], [node()])).toBe(base);
  });
  it("honors user DNS choices and handles a separate proxy endpoint resolver", () => {
    const base = { dns: { "nameserver-policy": { "*.provider.example": ["1.1.1.1"] }, "proxy-server-nameserver": ["223.5.5.5"] } };
    const manual = applySourceDnsDependencies(base, [{ id: "one", dnsDependencies: dependencies }], [node()]);
    expect((manual.dns as Record<string, unknown>)["nameserver-policy"]).toEqual(base.dns["nameserver-policy"]);
    const dedicated = applySourceDnsDependencies({ dns: { "proxy-server-nameserver": ["223.5.5.5"] } }, [{ id: "one", dnsDependencies: dependencies }], [node()]);
    expect((dedicated.dns as Record<string, unknown>)["proxy-server-nameserver-policy"]).toEqual({ "entry.provider.example": dependencies.policies["*.provider.example"] });
  });
  it("rejects unsafe metadata and never guesses conflicting resolver settings", () => {
    const normalized = normalizeSourceDnsDependencies({ policies: { "*.provider.example": ["file:///etc/passwd"], "node.example": ["https://u:p@dns.example/query"], "another.example": ["999.999.999.999:53"] }, hosts: { "resolver.example": ["not-an-ip"] } });
    expect(normalized).toEqual({ policies: {}, hosts: {} });
    expect(() => applySourceDnsDependencies({ dns: {} }, [
      { id: "one", dnsDependencies: dependencies },
      { id: "two", dnsDependencies: { ...dependencies, policies: { "*.provider.example": ["https://different.example/dns-query"] } } },
    ], [{ ...node(), _sourceIds: ["one", "two"] }])).toThrow("冲突");
  });
  it("generates DNS dependencies without changing nodes, groups or routing", () => {
    const plain = generateClashConfig({ nodes: [node()], template: "ai-split" });
    const fixed = generateClashConfig({ nodes: [node()], sources: [{ id: "one", dnsDependencies: dependencies }], template: "ai-split" });
    expect(fixed.proxies).toEqual(plain.proxies);
    expect(fixed["proxy-groups"]).toEqual(plain["proxy-groups"]);
    expect(fixed.rules).toEqual(plain.rules);
    expect(fixed.dns).toHaveProperty("nameserver-policy");
    expect(fixed.hosts).toEqual(dependencies.hosts);
  });
});
