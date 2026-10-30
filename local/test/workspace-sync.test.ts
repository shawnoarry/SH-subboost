import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWorkspace, compareWorkspace, nextWorkspace, validateWorkspaceDocument, validateWorkspaceSnapshot } from "@local/lib/workspace/snapshot";
import { decryptWorkspace, encryptWorkspace, WORKSPACE_KDF_ITERATIONS } from "@local/lib/workspace/crypto";
import { authorizeWorkspaceFile, readWorkspaceFile, writeWorkspaceFile, type WorkspaceFileHandle } from "@local/lib/workspace/files";
import { clearWorkspaceEditor, replaceWorkspaceEditor } from "@local/lib/workspace/editor";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { initialState, type ConfigState } from "@subboost/ui/store/config-store/definitions";
import { useUIStore } from "@subboost/ui/store/ui-store";
import { computeGeneratedYamlResult } from "@subboost/ui/store/config-store/generated-yaml";
import { SourceImportOperationGuard } from "@subboost/ui/store/config-store/source-import-operation";

const password = "test-only-long-passphrase-密钥";

function fixture(): ConfigState {
  return {
    ...structuredClone(initialState),
    sources: [{ id: "source-1", type: "url", content: "https://subscription.example.com/private-token", tag: "机场A", nameTemplate: "{tag}-{name}", parsed: true, lastParsedContent: "https://subscription.example.com/private-token" }],
    nodes: [{ name: "日本-保留", type: "ss", server: "jp.example.com", port: 8388, cipher: "aes-128-gcm", password: "private-node-password", _originName: "日本", _sourceIds: ["source-1"] } as any],
    deletedNodeNames: ["美国-删除"],
    deletedNodes: [{ originName: "美国-删除", name: "美国-删除", node: { name: "美国-删除", type: "ss", server: "us.example.com", port: 8388, cipher: "aes-128-gcm", password: "deleted-password", _sourceIds: ["source-1"] } as any, listenerPort: 12002, dialerRelayGroupIds: [], dialerTargetGroupIds: [] }],
    nodeNameFilter: { enabled: true, excludeRegexes: ["过期"], includeRegexes: ["日本|美国"] },
    customRules: [{ id: "custom-1", type: "DOMAIN", value: "example.com", target: { kind: "module", id: "select" } }],
    listenerPorts: { "日本-保留": 12001 },
    groupListeners: [{ id: "listener-1", target: { kind: "module", id: "select" }, port: 12003, allowLan: false }],
    proxyGroupOrder: ["module:select", "module:final"],
    history: ["private-previous-yaml"], parseErrors: ["private-import-error"],
  };
}

describe("portable workspace data", () => {
  it("validates relay nodes, optional source metadata and deleted-node/listener relationships", () => {
    const snapshot = captureWorkspace(fixture());
    const relay = { name: "relay", type: "relay", proxies: ["日本-保留"], _originName: "old-relay" };
    expect(validateWorkspaceSnapshot({ ...snapshot, nodes: [...snapshot.nodes, relay] }).nodes).toHaveLength(2);
    expect(() => validateWorkspaceSnapshot({ ...snapshot, nodes: [{ ...relay, proxies: [] }] })).toThrow("中转节点");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, nodes: [{ ...relay, _originName: 12 }] })).toThrow("节点原名");
    const source = { id: "plain", type: "nodes", content: "", nodeCount: 0, subscriptionUserInfo: {}, useProxyProviders: false, userinfoUrl: "https://info.example/" };
    expect(validateWorkspaceSnapshot({ ...snapshot, sources: [source] }).sources[0].nodeCount).toBe(0);
    for (const nodeCount of [-1, 1.5, "bad"]) expect(() => validateWorkspaceSnapshot({ ...snapshot, sources: [{ ...source, nodeCount }] })).toThrow("节点数");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, sources: [{ ...source, userinfoUrl: "malformed" }] })).toThrow("无效订阅链接");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, sources: [{ ...source, userinfoUrl: "https://user@info.example/" }] })).toThrow("内嵌账号密码");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, sources: [{ ...source, userinfoUrl: "https://:pass@info.example/" }] })).toThrow("内嵌账号密码");
    expect(validateWorkspaceSnapshot({ ...snapshot, deletedNodes: [{ name: "deleted", originName: "deleted" }] }).deletedNodes).toHaveLength(1);
    const listener = { id: "l", port: 12001, target: { kind: "module", id: "select" }, enabled: true, allowLan: false };
    expect(validateWorkspaceSnapshot({ ...snapshot, groupListeners: [listener] }).groupListeners).toHaveLength(1);
    expect(() => validateWorkspaceSnapshot({ ...snapshot, groupListeners: [{ ...listener, enabled: "yes" }] })).toThrow("分组监听开关");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, groupListeners: [{ ...listener, target: { kind: "unknown", id: "x" } }] })).toThrow("分组监听设置");
  });
  it("carries source DNS dependencies through encrypted export/import and configuration generation", async () => {
    const state = fixture();
    state.sources[0].dnsDependencies = { policies: { "*.example.com": ["https://resolver.example.com/query"] }, hosts: { "resolver.example.com": ["203.0.113.4"] } };
    const document = nextWorkspace(captureWorkspace(state), "DNS fixture");
    const encrypted = await encryptWorkspace(document, password);
    const loaded = await decryptWorkspace(encrypted, password);
    expect(loaded.state.sources[0].dnsDependencies).toEqual(state.sources[0].dnsDependencies);
    expect(computeGeneratedYamlResult({ ...state, ...loaded.state }).yaml).toContain("https://resolver.example.com/query");
    expect(encrypted).not.toContain("resolver.example.com");
  });
  it("preserves nodes, original identity, deleted-node restoration data, sources, routing, DNS and listeners", () => {
    const original = fixture();
    const snapshot = validateWorkspaceSnapshot(captureWorkspace(original));
    for (const field of ["sources", "nodes", "deletedNodeNames", "deletedNodes", "nodeNameFilter", "dnsYaml", "listenerPorts", "groupListeners", "proxyGroupOrder"] as const) expect(snapshot[field]).toEqual(original[field]);
    expect(snapshot.customRules[0]).toMatchObject({ value: "example.com", target: { kind: "module", id: "select" } });
    expect(snapshot).not.toHaveProperty("history");
    expect(snapshot).not.toHaveProperty("generatedYaml");
    expect(snapshot).not.toHaveProperty("draftRevision");
    expect(snapshot).not.toHaveProperty("parseErrors");
    expect(snapshot).not.toHaveProperty("token");
    expect(snapshot.sources[0]).not.toHaveProperty("parsing");
  });

  it("removes transient source failures and tolerates undefined parser fields", () => {
    const state = fixture();
    state.sources[0].parsing = true;
    state.sources[0].error = "private-error";
    (state.nodes[0] as any).sni = undefined;
    const saved = validateWorkspaceSnapshot(captureWorkspace(state));
    expect(saved.sources[0]).not.toHaveProperty("error");
    expect(saved.nodes[0]).not.toHaveProperty("sni");
  });

  it("rejects malformed state before it can replace the editor", () => {
    const snapshot = captureWorkspace(fixture());
    expect(() => validateWorkspaceSnapshot({ ...snapshot, mixedPort: 0 })).toThrow("生成设置无效");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, nodes: [{ name: "bad", type: "ss", server: "host", port: -1 }] })).toThrow();
    expect(() => validateWorkspaceSnapshot({ ...snapshot, sources: [{ id: "s", type: "url", content: "javascript:alert(1)" }] })).toThrow();
    expect(() => validateWorkspaceSnapshot({ ...snapshot, listenerPorts: { bad: 70000 } })).toThrow();
    expect(() => validateWorkspaceSnapshot({ ...snapshot, nodeNameFilter: { enabled: true, excludeRegexes: ["["] } })).toThrow();
    expect(() => validateWorkspaceSnapshot({ ...snapshot, nodes: [...snapshot.nodes, ...snapshot.nodes] })).toThrow("重复");
    expect(() => validateWorkspaceSnapshot({ ...snapshot, ...JSON.parse('{"__proto__":{"polluted":true}}') })).toThrow("不安全");
    expect(() => validateWorkspaceSnapshot({ sources: [] })).toThrow("不完整");
    expect(({} as any).polluted).toBeUndefined();
  });

  it("distinguishes descendants, old revisions, branches and unrelated workspaces", () => {
    const a = nextWorkspace(captureWorkspace(fixture()), "个人配置");
    const b = nextWorkspace(a.state, a.name, a);
    const c = nextWorkspace(a.state, a.name, a);
    expect(compareWorkspace(a, a)).toBe("same");
    expect(compareWorkspace(a, b)).toBe("newer");
    expect(compareWorkspace(b, a)).toBe("older");
    expect(compareWorkspace(b, c)).toBe("diverged");
    expect(compareWorkspace(a, nextWorkspace(a.state, "另一个配置"))).toBe("different");
    expect(() => validateWorkspaceDocument({ ...a, schema: "subboost-workspace/v999" })).toThrow();
  });
});

describe("workspace encryption", () => {
  it("round-trips the complete workspace and hides all metadata and node credentials", async () => {
    const document = nextWorkspace(captureWorkspace(fixture()), "个人私密工作配置");
    const encrypted = await encryptWorkspace(document, password);
    for (const secret of ["private-token", "private-node-password", "deleted-password", "日本", document.name, document.workspaceId, document.updatedAt]) expect(encrypted).not.toContain(secret);
    expect(await decryptWorkspace(encrypted, password)).toEqual(document);
    expect(JSON.parse(encrypted).iterations).toBe(WORKSPACE_KDF_ITERATIONS);
    expect(await encryptWorkspace(document, password)).not.toBe(encrypted);
  });

  it("fails closed with a wrong password or modified ciphertext, IV or salt", async () => {
    const encrypted = await encryptWorkspace(nextWorkspace(captureWorkspace(fixture()), "test"), password);
    await expect(decryptWorkspace(encrypted, "wrong-password")).rejects.toThrow("密码不正确");
    for (const field of ["data", "iv", "salt"]) {
      const envelope = JSON.parse(encrypted);
      envelope[field] = (envelope[field][0] === "A" ? "B" : "A") + envelope[field].slice(1);
      await expect(decryptWorkspace(JSON.stringify(envelope), password)).rejects.toThrow("密码不正确");
    }
  });

  it("rejects weak passwords, incompatible envelopes and malicious work factors", async () => {
    const document = nextWorkspace(captureWorkspace(fixture()), "test");
    await expect(encryptWorkspace(document, "short")).rejects.toThrow("至少 12");
    await expect(decryptWorkspace("not JSON", password)).rejects.toThrow("请选择");
    const envelope = JSON.parse(await encryptWorkspace(document, password));
    await expect(decryptWorkspace(JSON.stringify({ ...envelope, iterations: 999999999999 }), password)).rejects.toThrow("不支持");
    await expect(decryptWorkspace(JSON.stringify({ ...envelope, iv: "bad!" }), password)).rejects.toThrow("格式无效");
  });
});

describe("workspace file synchronization", () => {
  function handle(text: string) {
    const writer = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const fileHandle: WorkspaceFileHandle = { name: "workspace.subboost", getFile: vi.fn(async () => ({ size: text.length, text: async () => text } as File)), createWritable: vi.fn(async () => writer) };
    return { fileHandle, writer };
  }

  it("refuses to overwrite a file changed by another PC", async () => {
    const { fileHandle, writer } = handle("new revision from office");
    await expect(writeWorkspaceFile(fileHandle, "local encrypted update", "old revision")).rejects.toThrow("其他电脑修改");
    expect(fileHandle.createWritable).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  it("commits only after the expected encrypted version matches, and aborts failed writes", async () => {
    const { fileHandle, writer } = handle("expected");
    await writeWorkspaceFile(fileHandle, "encrypted replacement", "expected");
    expect(writer.write).toHaveBeenCalledWith("encrypted replacement");
    expect(writer.close).toHaveBeenCalledOnce();
    writer.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(writeWorkspaceFile(fileHandle, "replacement", "expected")).rejects.toThrow("disk full");
    expect(writer.abort).toHaveBeenCalledOnce();
  });

  it("checks file sizes before reading and respects denied file permission", async () => {
    const text = vi.fn();
    await expect(readWorkspaceFile({ size: 30 * 1024 * 1024, text })).rejects.toThrow("过大");
    expect(text).not.toHaveBeenCalled();
    const { fileHandle } = handle("");
    fileHandle.requestPermission = vi.fn(async () => "denied");
    await expect(authorizeWorkspaceFile(fileHandle, "readwrite")).rejects.toThrow("未授权");
  });
});

describe("workspace editor restoration", () => {
  beforeEach(() => { clearWorkspaceEditor(); });

  it("generates identical output, clears this PC's subscription context, and retains deletion restoration", () => {
    const snapshot = nextWorkspace(captureWorkspace(fixture()), "test").state;
    const beforeRevision = useConfigStore.getState().draftRevision;
    useUIStore.setState({ editingSubscription: { id: "local-only-id", token: "local-only-token", name: "local", autoUpdateInterval: null, smartNodeMatchingEnabled: true } });
    replaceWorkspaceEditor(snapshot);
    const restored = useConfigStore.getState();
    expect(restored.draftRevision).toBe(beforeRevision + 1);
    expect(restored.generatedYaml).toBe(computeGeneratedYamlResult({ ...initialState, ...snapshot }).yaml);
    expect(restored.generatedYaml).toContain("日本-保留");
    expect(restored.generatedYaml).not.toContain("us.example.com");
    expect(restored.history).toEqual([]);
    expect(useUIStore.getState().editingSubscription).toBeNull();
    restored.restoreDeletedNode("美国-删除");
    expect(useConfigStore.getState().nodes.map((node) => node.name)).toContain("美国-删除");
  });

  it("does not mutate the current editor when imported validation fails", () => {
    replaceWorkspaceEditor(captureWorkspace(fixture()));
    const before = useConfigStore.getState();
    expect(() => replaceWorkspaceEditor({ ...captureWorkspace(fixture()), nodes: "invalid" } as any)).toThrow();
    expect(useConfigStore.getState()).toBe(before);
  });

  it("invalidates in-flight imports when replacing or locking a workspace", () => {
    replaceWorkspaceEditor(captureWorkspace(fixture()));
    const guard = new SourceImportOperationGuard(() => useConfigStore.getState().draftRevision);
    const operation = guard.startSingle(useConfigStore.getState().sources[0]);
    const batch = guard.startBatch(useConfigStore.getState().sources);
    replaceWorkspaceEditor(captureWorkspace(fixture()));
    expect(guard.isSingleCurrent(useConfigStore.getState().sources, operation)).toBe(false);
    expect(guard.isBatchCurrent(useConfigStore.getState().sources, batch)).toBe(false);
    const next = guard.startSingle(useConfigStore.getState().sources[0]);
    clearWorkspaceEditor();
    expect(guard.ownsSingle(next)).toBe(false);
  });

  it("locking removes plaintext editor data while retaining store actions", () => {
    replaceWorkspaceEditor(captureWorkspace(fixture()));
    clearWorkspaceEditor();
    expect(useConfigStore.getState().nodes).toEqual([]);
    expect(useConfigStore.getState().sources.every((source) => source.content === "")).toBe(true);
    expect(useConfigStore.getState().generatedYaml).toBe("");
    expect(typeof useConfigStore.getState().generateConfig).toBe("function");
  });
});
