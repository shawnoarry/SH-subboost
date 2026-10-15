import { describe, expect, it } from "vitest";
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import { generateClashConfig } from "@subboost/core/generator";
import { getModulesForTemplate } from "@subboost/core/generator/proxy-groups";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import { builtinIdToType, getBuiltinTemplateId } from "./builtin";
import { validateSubBoostTemplateConfig } from "./config-template";

const nodes = ["AI line", "Low rate line"].map((name) => ({
  name,
  type: "ss" as const,
  server: "proxy.example.com",
  port: 8388,
  cipher: "aes-128-gcm",
  password: "test-only",
}));

describe("AI split builtin template", () => {
  it("adds an optional preset while preserving the original presets", () => {
    expect(getBuiltinTemplateId("ai-split")).toBe("builtin-ai-split");
    expect(builtinIdToType("builtin-ai-split")).toBe("ai-split");
    expect(getModulesForTemplate("full")).toHaveLength(33);
    for (const type of ["minimal", "standard", "full"] as const) {
      expect(getModulesForTemplate(type)).not.toEqual(expect.arrayContaining(["openai"]));
      expect(getModulesForTemplate(type)).not.toEqual(expect.arrayContaining(["claude"]));
      expect(getModulesForTemplate(type)).not.toEqual(expect.arrayContaining(["ai-other"]));
    }
    expect(getModulesForTemplate("ai-split")).toEqual(
      getModulesForTemplate("full").flatMap((id) => id === "ai" ? ["openai", "claude", "gemini", "ai-other"] : [id])
    );
  });

  it("gives each supplier a manual node selector and one corresponding rule", () => {
    const config = generateClashConfig({ template: "ai-split", nodes });
    const groups = config["proxy-groups"]!;
    const rules = config.rules!;
    const suppliers = [
      ["openai-split", "🤖 OpenAI / Codex", "openai"],
      ["anthropic-split", "🧠 Claude", "anthropic"],
      ["google-gemini", "✨ Gemini", "google-gemini"],
      ["ai-chat-other", "🤖 其他 AI", "category-ai-chat-!cn"],
    ];
    for (const [provider, name, source] of suppliers) {
      expect(groups.find((group) => group.name === name)).toMatchObject({
        type: "select",
        proxies: expect.arrayContaining(nodes.map((node) => node.name)),
      });
      expect(rules.filter((rule) => rule.startsWith(`RULE-SET,${provider},`))).toEqual([`RULE-SET,${provider},${name}`]);
      expect(config["rule-providers"]?.[provider].url).toContain(`/geosite/${source}.mrs`);
    }
    expect(groups.some((group) => group.name === "🤖 AI 服务")).toBe(false);
    expect(config.proxies).toEqual(nodes);
  });

  it("matches suppliers before aggregate AI, Google and Cloudflare; keeps video and GitHub separate", () => {
    const rules = generateClashConfig({ template: "ai-split", nodes }).rules!;
    const index = (id: string) => {
      const value = rules.findIndex((rule) => rule.startsWith(`RULE-SET,${id},`));
      expect(value).toBeGreaterThanOrEqual(0);
      return value;
    };
    for (const id of ["openai-split", "anthropic-split", "google-gemini"]) {
      expect(index(id)).toBeLessThan(index("ai-chat-other"));
      expect(index(id)).toBeLessThan(index("google"));
      expect(index(id)).toBeLessThan(index("cloudflare-ip"));
    }
    expect(index("youtube")).toBeLessThan(index("google"));
    expect(rules[index("youtube")]).toBe("RULE-SET,youtube,📹 油管视频");
    expect(rules[index("github")]).toBe("RULE-SET,github,🐱 代码托管");
    expect(rules[index("google")]).toBe("RULE-SET,google,🔍 谷歌服务");
  });

  it("round trips template exports and persisted subscriptions without falling back to standard", () => {
    const preset = buildDefaultSubBoostTemplateConfig("ai-split");
    const validated = validateSubBoostTemplateConfig(JSON.parse(JSON.stringify(preset)));
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error(validated.error);
    expect(validated.config.template).toBe("ai-split");
    const options = buildGenerateOptionsFromConfig({ template: validated.config.template }, { nodes });
    expect(options.template).toBe("ai-split");
    expect(generateClashConfig(options)).toEqual(generateClashConfig({ template: "ai-split", nodes }));
  });
});
