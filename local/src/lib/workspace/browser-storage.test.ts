// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { readWorkspaceCache, writeWorkspaceCache } from "./cache";
import { authorizeWorkspaceFile, downloadWorkspaceFile, pickNewWorkspaceFile, pickWorkspaceFile, readWorkspaceFile, supportsWorkspaceFileAccess, writeWorkspaceFile, type WorkspaceFileHandle } from "./files";
import { MAX_ENCRYPTED_FILE_BYTES } from "./crypto";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("encrypted browser cache", () => {
  it("round trips ciphertext, isolates accounts and replaces the previous copy", async () => {
    expect(await readWorkspaceCache("local:a")).toBeNull();
    await writeWorkspaceCache("local:a", { encrypted: "ciphertext-1", linkedText: "ciphertext-1" });
    expect(await readWorkspaceCache("local:a")).toEqual({ encrypted: "ciphertext-1", linkedText: "ciphertext-1" });
    expect(await readWorkspaceCache("local:b")).toBeNull();
    await writeWorkspaceCache("local:a", { encrypted: "ciphertext-2" });
    expect(await readWorkspaceCache("local:a")).toEqual({ encrypted: "ciphertext-2" });
  });

  it("rejects uncloneable handles without replacing a valid cached copy", async () => {
    await writeWorkspaceCache("local:a", { encrypted: "old" });
    await expect(writeWorkspaceCache("local:a", { encrypted: "new", handle: { getFile: () => undefined } as unknown as WorkspaceFileHandle })).rejects.toThrow();
    expect(await readWorkspaceCache("local:a")).toEqual({ encrypted: "old" });
  });

  it.each(["open", "get", "error", "abort"])("reports %s failure and closes an opened database", async (failure) => {
    const close = vi.fn();
    const request: Record<string, unknown> = {};
    const transaction: Record<string, unknown> = {};
    const event = (target: Record<string, unknown>, key: string) => queueMicrotask(() => (target[key] as () => void)());
    transaction.objectStore = () => ({
      get: () => { event(request, "onerror"); return request; },
      put: () => event(transaction, failure === "abort" ? "onabort" : "onerror"),
    });
    vi.stubGlobal("indexedDB", { open: () => {
      const opening: Record<string, unknown> = { result: { transaction: () => transaction, close } };
      event(opening, failure === "open" ? "onerror" : "onsuccess");
      return opening;
    } });
    if (failure === "open" || failure === "get") await expect(readWorkspaceCache("a")).rejects.toThrow(failure === "open" ? "浏览器无法保存" : "无法读取");
    else await expect(writeWorkspaceCache("a", { encrypted: "ciphertext" })).rejects.toThrow("无法保存");
    expect(close).toHaveBeenCalledTimes(failure === "open" ? 0 : 1);
  });
});

describe("workspace file boundaries", () => {
  const handle = () => ({ name: "test.subboost", getFile: vi.fn().mockResolvedValue({ size: 3, text: async () => "old" }), createWritable: vi.fn() });
  it("requires both picker APIs and reports unsupported browsers and empty choices", async () => {
    expect(supportsWorkspaceFileAccess()).toBe(false);
    await expect(pickWorkspaceFile()).rejects.toThrow("Chrome");
    await expect(pickNewWorkspaceFile()).rejects.toThrow("不支持");
    vi.stubGlobal("window", { showOpenFilePicker: vi.fn().mockResolvedValue([]) });
    expect(supportsWorkspaceFileAccess()).toBe(false);
    await expect(pickWorkspaceFile()).rejects.toThrow("未选择");
    const selected = handle();
    const open = vi.fn().mockResolvedValue([selected]);
    const save = vi.fn().mockResolvedValue(selected);
    vi.stubGlobal("window", { showOpenFilePicker: open, showSaveFilePicker: save });
    expect(supportsWorkspaceFileAccess()).toBe(true);
    expect(await pickWorkspaceFile()).toBe(selected);
    expect(await pickNewWorkspaceFile()).toBe(selected);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "subboost-workspace.subboost" }));
    vi.stubGlobal("window", undefined);
    expect(supportsWorkspaceFileAccess()).toBe(false);
  });
  it("requests the intended permission and accepts handles without a permission API", async () => {
    const selected = handle();
    await authorizeWorkspaceFile(selected, "read");
    const requestPermission = vi.fn().mockResolvedValue("denied");
    await expect(authorizeWorkspaceFile({ ...selected, requestPermission }, "readwrite")).rejects.toThrow("未授权");
    requestPermission.mockResolvedValue("granted");
    await authorizeWorkspaceFile({ ...selected, requestPermission }, "read");
    expect(requestPermission.mock.calls).toEqual([[{ mode: "readwrite" }], [{ mode: "read" }]]);
  });
  it("rejects oversized ciphertext before reading it", async () => {
    const text = vi.fn().mockResolvedValue("cipher");
    await expect(readWorkspaceFile({ size: MAX_ENCRYPTED_FILE_BYTES + 1, text })).rejects.toThrow("过大");
    expect(text).not.toHaveBeenCalled();
    expect(await readWorkspaceFile({ size: MAX_ENCRYPTED_FILE_BYTES, text })).toBe("cipher");
  });
  it.each(["write", "close"])("aborts a failed %s and retains the original error even if abort fails", async (step) => {
    const writer = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockRejectedValue(new Error("abort")) };
    const failure = new Error(`${step} failed`);
    writer[step as "write" | "close"].mockRejectedValue(failure);
    const selected = handle(); selected.createWritable.mockResolvedValue(writer);
    await expect(writeWorkspaceFile(selected, "new", "old")).rejects.toBe(failure);
    expect(writer.abort).toHaveBeenCalledOnce();
    if (step === "write") expect(writer.close).not.toHaveBeenCalled();
  });
  it("downloads ciphertext with the portable filename and releases its object URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue("blob:encrypted");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("subboost-workspace.subboost");
      expect(this.getAttribute("href")).toBe("blob:encrypted");
      expect(this.isConnected).toBe(true);
    });
    downloadWorkspaceFile("ciphertext only");
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0].type).toBe("application/octet-stream");
    expect(document.querySelector("a")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:encrypted");
  });
});
