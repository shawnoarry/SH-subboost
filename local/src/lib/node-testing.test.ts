import { describe, expect, it } from "vitest";
import { isolatedProbeConfig, physicalInterfaces, startNodeTests, nodeTestJob } from "./node-testing";
import type { ParsedNode } from "@subboost/core/types/node";

describe("isolated node detection", () => {
  it("builds a closed isolated core config, independent of running Clash", () => {
    const node = { name: "test", type: "ss", server: "example.com", port: 443, cipher: "aes-128-gcm", password: "secret", "interface-name": "Mihomo", "routing-mark": 20 } as ParsedNode;
    const config = isolatedProbeConfig([node], 45678, "random-secret", "WLAN");
    expect(config.tun).toEqual({ enable: false, "auto-route": false });
    expect(config.dns.enable).toBe(false);
    expect(config["mixed-port"]).toBe(0);
    expect(config["external-controller"]).toBe("127.0.0.1:45678");
    expect(config["interface-name"]).toBe("WLAN");
    expect(config.listeners).toEqual([]);
    expect(config["proxy-groups"]).toEqual([]);
    expect(config.rules).toEqual(["MATCH,REJECT"]);
    expect(config.proxies[0]).not.toHaveProperty("interface-name");
    expect(config.proxies[0]).not.toHaveProperty("routing-mark");
    expect(node["interface-name"]).toBe("Mihomo");
  });
  it("excludes virtual, loopback and disconnected network interfaces", () => {
    const address = { address: "192.168.1.2", family: "IPv4" as const, internal: false, mac: "12:34:56:78:90:ab", netmask: "255.255.255.0", cidr: "192.168.1.2/24" };
    expect(physicalInterfaces({ WLAN: [address], Mihomo: [address], "vEthernet (WSL)": [address], bad: [{ ...address, address: "169.254.1.1" }] })).toEqual(["WLAN"]);
  });
  it("rejects empty, duplicate, forged or excessive selections before any process starts", async () => {
    for (const ids of [[], ["node-0", "node-0"], ["../../x"], Array.from({ length: 201 }, (_, i) => `node-${i}`)]) {
      await expect(startNodeTests("owner", "sub", [], ids)).rejects.toThrow("请选择");
    }
    await expect(startNodeTests("owner", "sub", [], ["node-0"])).rejects.toThrow("不存在");
    expect(() => nodeTestJob("owner", "sub", "not-a-job")).toThrow("不存在");
  });
});
