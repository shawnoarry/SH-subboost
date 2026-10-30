import { describe, expect, it } from "vitest";
import { generateClashConfig } from "../generator";
import { buildGenerateOptionsFromConfig } from "./config-utils";
import { normalizeProxyGroupAdvancedConfig } from "../proxy-group-advanced";
import { isCustomRuleType } from "../rules/custom-rule-utils";

describe("local routing import compatibility", () => {
  it("retains a logical rule and per-group health-check settings through normalization", () => {
    const config = {
      template: "minimal", enabledGroups: ["select", "auto", "cloud", "final"],
      customRules: [{ id: "logical", type: "AND", value: "((DOMAIN-REGEX,.+),(RULE-SET,cloudflare-ip,no-resolve))", target: "DIRECT" }],
      proxyGroupAdvanced: { auto: { testInterval: 1800, lazy: true, tolerance: 80 } },
    };
    const generated = generateClashConfig(buildGenerateOptionsFromConfig(config, {
      nodes: [{ name: "Example", type: "ss", server: "example.com", port: 443, cipher: "aes-128-gcm", password: "test-only" }],
    }));
    expect(isCustomRuleType("AND")).toBe(true);
    expect(generated.rules).toContain("AND,((DOMAIN-REGEX,.+),(RULE-SET,cloudflare-ip,no-resolve)),DIRECT");
    expect(generated["proxy-groups"]?.find((group) => group.type === "url-test"))
      .toMatchObject({ interval: 1800, lazy: true, tolerance: 80 });
  });
  it("rejects invalid timing values without changing defaults", () => {
    expect(normalizeProxyGroupAdvancedConfig({ testInterval: -1, lazy: "yes", tolerance: NaN })).toEqual({});
  });
});
