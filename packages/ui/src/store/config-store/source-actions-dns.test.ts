import { beforeEach, describe, expect, it } from "vitest";
import { createHarness, getSourceActionMocks, node, parseResult, resetSourceActionMocks, source } from "./source-actions.test-utils";
import { computeGeneratedYaml } from "./generated-yaml";

const dns = { policies: { "*.provider.example": ["https://dns.provider.example/dns-query"] }, hosts: { "dns.provider.example": ["203.0.113.4"] } };
const content = "proxies: []\ndns:\n  nameserver-policy:\n    '*.provider.example': [https://dns.provider.example/dns-query]\nhosts:\n  dns.provider.example: [203.0.113.4]\n";
describe("source editor DNS compatibility", () => {
  beforeEach(resetSourceActionMocks);
  it.each(["single", "batch"])("captures dependencies during a %s import and generates them", async (mode) => {
    const imported = node("Provider", { server: "entry.provider.example" });
    getSourceActionMocks().parseSubscription.mockReturnValue(parseResult([imported]));
    const entry = source({ id: "s1", type: "yaml", content });
    const { actions, getState } = createHarness({ sources: [entry] });
    if (mode === "single") await actions.parseSingleSource("s1");
    else await actions.parseMultipleSources([entry]);
    expect(getState().sources[0].dnsDependencies).toEqual(dns);
    expect(computeGeneratedYaml(getState())).toContain("entry.provider.example");
    expect(computeGeneratedYaml(getState())).toContain("https://dns.provider.example/dns-query");
  });
});
