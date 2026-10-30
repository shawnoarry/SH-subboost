import { describe, expect, it } from "vitest";
import * as yaml from "js-yaml";
import type { ParsedNode } from "../types/node";
import { applySourceDnsDependencies, dnsPatternMatches, extractSourceDnsDependencies, normalizeSourceDnsDependencies, refreshSourceDnsDependencies } from "./source-dns";
import { generateClashConfig } from "../generator";

const node = (server = "entry.provider.example", source = "one"): ParsedNode => ({ name: server, type: "trojan", server, port: 443, password: "test-only", _sourceIds: [source] });
const dependencies = { policies: { "*.provider.example": ["https://resolver.provider.example/dns-query"] }, hosts: { "resolver.provider.example": ["203.0.113.3"] } };
const input = yaml.dump({ proxies: [node()], dns: { "nameserver-policy": { ...dependencies.policies, "geosite:cn": ["223.5.5.5"], "unrelated.example": ["1.1.1.1"] } }, hosts: { ...dependencies.hosts, "unrelated.example": ["203.0.113.8"] }, tun: { enable: true }, secret: "never-import-this" });
describe("source DNS compatibility", () => {
  it("validates resolver and hosts metadata boundaries without admitting credentials or malformed addresses", () => {
    for (const invalid of [null, [], {}, { policies: {}, hosts: [] }]) expect(normalizeSourceDnsDependencies(invalid)).toBeUndefined();
    const invalidResolvers = [null, "", "a".repeat(2049), "1.1.1.1\n", "https://u@dns.test/query", "https://dns.test/query#proxy=secret", "tls:", "not a resolver", "1.1.1.1:0", "1.1.1.1:65536", "[bad::address]", [], Array(17).fill("1.1.1.1")];
    for (const resolver of invalidResolvers) expect(normalizeSourceDnsDependencies({ policies: { "node.test": resolver }, hosts: {} })).toEqual({ policies: {}, hosts: {} });
    const good = ["system", "2001:db8::1", "1.1.1.1:53", "https://dns.test/query#h3=true&disable-ipv6=true"];
    expect(normalizeSourceDnsDependencies({ policies: { "Node.Test.": [...good, "system"] }, hosts: { "DNS.TEST.": "2001:db8::1" } })).toEqual({ policies: { "node.test": good }, hosts: { "dns.test": ["2001:db8::1"] } });
    for (const key of ["*.bad name", "+.bad name", "bad name", "a".repeat(254)]) expect(normalizeSourceDnsDependencies({ policies: { [key]: "1.1.1.1" }, hosts: {} })?.policies).toEqual({});
    for (const [key, values] of [["localhost", "1.1.1.1"], ["bad name", "1.1.1.1"], ["dns.test", []], ["dns.test", Array(33).fill("1.1.1.1")], ["dns.test", [123]], ["dns.test", ["2001:::1"]]] as const) expect(normalizeSourceDnsDependencies({ policies: {}, hosts: { [key]: values } })?.hosts).toEqual({});
  });
  it("matches exact, suffix and wildcard DNS names with distinct apex behavior", () => {
    expect(dnsPatternMatches("*", "any.test")).toBe(true);
    expect(dnsPatternMatches("+.test.example", "test.example")).toBe(true);
    expect(dnsPatternMatches("+.test.example", "sub.test.example")).toBe(true);
    expect(dnsPatternMatches("+.test.example", "other.example")).toBe(false);
    expect(dnsPatternMatches("*.test.example", "test.example")).toBe(false);
  });
  it("handles hosts-only and proxy-resolver-only documents and rejects malformed YAML/base64", () => {
    expect(extractSourceDnsDependencies("hosts:\n  entry.provider.example: 203.0.113.2\n", [node()])).toEqual({ policies: {}, hosts: { "entry.provider.example": ["203.0.113.2"] } });
    expect(extractSourceDnsDependencies("dns:\n  proxy-server-nameserver-policy:\n    '*': system\n", [node()])).toEqual({ policies: { "*": ["system"] }, hosts: {} });
    for (const text of ["###", "{broken", "dns: 123", "??badbase64", "_"]) expect(extractSourceDnsDependencies(text, [node()])).toBeUndefined();
  });
  it("prefers the most specific source policy while retaining manual proxy policies and host overrides", () => {
    const policies = { "*": ["1.0.0.1"], "+.example": ["1.0.0.2"], "*.provider.example": ["1.0.0.3"], "entry.provider.example": ["1.0.0.4"] };
    const source = { dnsDependencies: { policies, hosts: { "entry.provider.example": ["203.0.113.3"] } } };
    const base = { dns: { "proxy-server-nameserver": ["8.8.8.8"], "proxy-server-nameserver-policy": { "*.provider.example": ["8.8.4.4"] }, "use-hosts": false }, hosts: { "entry.provider.example": ["203.0.113.4"] } };
    const result = applySourceDnsDependencies(base, [source, source, {}], [node(), node("other.provider.example")]);
    expect(result.dns).toMatchObject({ "nameserver-policy": { "entry.provider.example": ["1.0.0.4"], "other.provider.example": ["1.0.0.3"] }, "proxy-server-nameserver-policy": base.dns["proxy-server-nameserver-policy"], "use-hosts": false });
    expect(result.hosts).toEqual(base.hosts);
    const reversed = { dnsDependencies: { policies: Object.fromEntries(Object.entries(policies).reverse()), hosts: source.dnsDependencies.hosts } };
    expect(applySourceDnsDependencies({ dns: { "use-hosts": false } }, [reversed], [node()])).toMatchObject({ hosts: source.dnsDependencies.hosts, dns: { "use-hosts": false, "nameserver-policy": { "entry.provider.example": ["1.0.0.4"] } } });
    expect(() => applySourceDnsDependencies({ dns: false }, [source], [node()])).toThrow("dns 为对象");
    const hostsOnly = applySourceDnsDependencies({}, [{ dnsDependencies: { policies: {}, hosts: { "entry.provider.example": ["203.0.113.3"] } } }], [node()]);
    expect(hostsOnly).toEqual({ hosts: { "entry.provider.example": ["203.0.113.3"] }, dns: { "use-hosts": true } });
    expect(applySourceDnsDependencies({}, [{ id: "one", dnsDependencies: source.dnsDependencies }], [{ ...node(), _sourceIds: undefined }])).toEqual({});
    expect(applySourceDnsDependencies({}, [source], [{ ...node(), server: "bad name" }])).toEqual({});
  });
  it("reads inherited DNS mappings through the common Mihomo YAML compatibility loader", () => {
    const merged = "defaults: &dns\n  nameserver-policy:\n    '*.provider.example': [https://resolver.provider.example/dns-query]\ndns:\n  <<: *dns\nhosts:\n  resolver.provider.example: [203.0.113.3]\n";
    expect(extractSourceDnsDependencies(merged, [node()])).toEqual(dependencies);
  });
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
