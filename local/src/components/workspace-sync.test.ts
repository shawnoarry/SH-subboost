// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConfigStore } from "@subboost/ui/store/config-store";
import { useUserStore } from "@subboost/ui/store/user-store";
import { initialState } from "@subboost/ui/store/config-store/definitions";
import { captureWorkspace, nextWorkspace, type WorkspaceDocument } from "@local/lib/workspace/snapshot";
import type { WorkspaceFileHandle } from "@local/lib/workspace/files";
import { WorkspaceSync } from "./workspace-sync";

const m = vi.hoisted(() => ({ confirm: vi.fn(), replaceRoute: vi.fn(), search: "", decrypt: vi.fn(), encrypt: vi.fn(), readCache: vi.fn(), writeCache: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), pick: vi.fn(), pickNew: vi.fn(), authorize: vi.fn(), download: vi.fn(), ephemeral: vi.fn(), clear: vi.fn(), replace: vi.fn(), fileAccess: true, memory: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: m.replaceRoute }), useSearchParams: () => new URLSearchParams(m.search) }));
vi.mock("@subboost/ui/components/ui/confirm-dialog", () => ({ confirmDialog: m.confirm }));
vi.mock("@subboost/ui/store/config-store", async () => {
  const { create } = await import("zustand");
  const { initialState } = await import("@subboost/ui/store/config-store/definitions");
  return { useConfigStore: create(() => structuredClone(initialState)), setConfigDraftEphemeral: m.ephemeral };
});
vi.mock("@subboost/ui/store/user-store", async () => {
  const { create } = await import("zustand");
  return { useUserStore: create(() => ({ user: { id: "a" }, isLoading: false })) };
});
vi.mock("@subboost/ui/store/config-store/draft-privacy", () => ({ isConfigDraftMemoryOnly: () => m.memory }));
vi.mock("@local/lib/workspace/crypto", async (original) => ({ ...await original<object>(), decryptWorkspace: m.decrypt, encryptWorkspace: m.encrypt }));
vi.mock("@local/lib/workspace/files", () => ({ supportsWorkspaceFileAccess: () => m.fileAccess, readWorkspaceFile: m.readFile, writeWorkspaceFile: m.writeFile, pickWorkspaceFile: m.pick, pickNewWorkspaceFile: m.pickNew, authorizeWorkspaceFile: m.authorize, downloadWorkspaceFile: m.download }));
vi.mock("@local/lib/workspace/cache", () => ({ readWorkspaceCache: m.readCache, writeWorkspaceCache: m.writeCache }));
vi.mock("@local/lib/workspace/editor", () => ({ clearWorkspaceEditor: m.clear, replaceWorkspaceEditor: m.replace }));

const password = "test-only-password";
let incoming: WorkspaceDocument;
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(new RegExp(`^${name}\\s*\\*?$`)), { target: { value } });
const mount = async () => { const view = render(React.createElement(WorkspaceSync)); click("加密同步"); await screen.findByRole("dialog"); return view; };
const upload = async () => { fireEvent.change(screen.getByLabelText("选择加密工作配置文件"), { target: { files: [Object.assign(new File(["cipher"], "test.subboost"), { text: async () => "cipher" })] } }); await screen.findByLabelText(/^加密密码\s*\*?$/); };
const unlock = async () => { fill("加密密码", password); click("解密并打开"); await screen.findByText(/已在本机解密并载入/); };
const create = async () => { click("创建加密文件"); fill("工作配置名称", "Home test"); fill("设置加密密码", password); fill("确认加密密码", password); click("加密导出当前配置"); await screen.findByText(/已生成加密下载文件/); };
const dirty = () => act(() => useConfigStore.setState({ mixedPort: 17890, draftRevision: useConfigStore.getState().draftRevision + 1 }));
const handle = (text = "cipher"): WorkspaceFileHandle => ({ name: "sync.subboost", getFile: vi.fn().mockResolvedValue({ size: text.length, text: async () => text }), createWritable: vi.fn() });
const defer = <T,>() => { let resolve!: (v: T) => void; let reject!: (v: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
beforeEach(() => {
  Object.values(m).forEach((value) => { if (vi.isMockFunction(value)) value.mockReset(); });
  m.search = ""; m.fileAccess = true; m.memory = false;
  useConfigStore.setState(structuredClone(initialState));
  useUserStore.setState({ user: { id: "a" } as ReturnType<typeof useUserStore.getState>["user"], isLoading: false });
  incoming = nextWorkspace(captureWorkspace(initialState), "Imported test");
  m.confirm.mockResolvedValue(true); m.decrypt.mockImplementation(async () => incoming); m.encrypt.mockResolvedValue("new-ciphertext");
  m.readCache.mockResolvedValue(null); m.writeCache.mockResolvedValue(undefined); m.readFile.mockImplementation(async (file) => file.text()); m.writeFile.mockResolvedValue(undefined);
  m.authorize.mockResolvedValue(undefined); m.pick.mockResolvedValue(handle()); m.pickNew.mockResolvedValue(handle(""));
  m.replace.mockImplementation((state) => useConfigStore.setState({ ...state, draftRevision: useConfigStore.getState().draftRevision + 1 }));
  m.clear.mockImplementation(() => useConfigStore.setState({ ...structuredClone(initialState), draftRevision: useConfigStore.getState().draftRevision + 1 }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("encrypted workspace browser workflow", () => {
  it("ignores a delayed cached copy after unmount", async () => {
    const pending = defer<null>(); m.readCache.mockReturnValue(pending.promise);
    const view = await mount(); view.unmount(); await act(async () => pending.resolve(null));
    expect(m.replace).not.toHaveBeenCalled();
  });
  it.each(["open", "connect"])("discards a pending %s file read after the active account changes", async (method) => {
    const pending = defer<string>(); m.readFile.mockReturnValue(pending.promise);
    await mount();
    if (method === "connect") click("连接已有同步文件");
    else fireEvent.change(screen.getByLabelText("选择加密工作配置文件"), { target: { files: [new File(["cipher"], "test.subboost")] } });
    await waitFor(() => expect(m.readFile).toHaveBeenCalled());
    act(() => useUserStore.setState({ user: null })); await act(async () => pending.resolve("cipher"));
    expect(screen.queryByLabelText(/^加密密码\s*\*?$/)).toBeNull(); expect(m.decrypt).not.toHaveBeenCalled();
  });
  it("does not show an error from a previous account's pending operation", async () => {
    const pending = defer<WorkspaceFileHandle>(); m.pick.mockReturnValue(pending.promise);
    await mount(); click("连接已有同步文件"); act(() => useUserStore.setState({ user: null }));
    await act(async () => pending.reject(new Error("old account error")));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("guards against concurrent submits and an import that starts before form submission", async () => {
    const pending = defer<WorkspaceDocument>(); m.decrypt.mockReturnValue(pending.promise);
    await mount(); await upload(); fill("加密密码", password);
    const form = screen.getByLabelText(/^加密密码\s*\*?$/).closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(m.decrypt).toHaveBeenCalledOnce(); await act(async () => pending.resolve(incoming));
    click("锁定"); await screen.findByText(/已锁定。再次使用/); click("解锁上次配置"); fill("加密密码", password);
    act(() => useConfigStore.setState({ isLoading: true }));
    fireEvent.submit(screen.getByLabelText(/^加密密码\s*\*?$/).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("请等待当前订阅导入完成");
    act(() => useConfigStore.setState({ isLoading: false })); click("取消"); click("创建加密文件"); fill("设置加密密码", password); fill("确认加密密码", password);
    act(() => useConfigStore.setState({ isLoading: true })); fireEvent.submit(screen.getByLabelText(/^设置加密密码\s*\*?$/).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("再加密保存"); expect(m.encrypt).not.toHaveBeenCalled();
  });
  it.each(["replace", "lock"])("discards a pending %s confirmation after switching accounts", async (operation) => {
    await mount(); await upload(); await unlock(); dirty();
    const confirmation = defer<boolean>(); m.confirm.mockReturnValue(confirmation.promise);
    if (operation === "lock") click("锁定");
    else { await upload(); fill("加密密码", password); click("解密并打开"); }
    await waitFor(() => expect(m.confirm).toHaveBeenCalled());
    act(() => useUserStore.setState({ user: null })); await act(async () => confirmation.resolve(true));
    expect(m.clear).not.toHaveBeenCalled(); expect(m.replace).toHaveBeenCalledOnce();
  });
  it("does not attach a completed file write to a different account", async () => {
    await mount(); await create(); const pending = defer<void>(); m.writeFile.mockReturnValue(pending.promise);
    click("选择同步保存位置"); await waitFor(() => expect(m.writeFile).toHaveBeenCalled());
    m.writeCache.mockClear(); act(() => useUserStore.setState({ user: null })); await act(async () => pending.resolve());
    expect(m.writeCache).not.toHaveBeenCalled(); expect(screen.queryByText("同步文件：sync.subboost")).toBeNull();
  });
  it("tolerates revoked file access and ignores polling results after the session is locked", async () => {
    await mount(); click("连接已有同步文件"); await screen.findByLabelText(/^加密密码\s*\*?$/); await unlock();
    m.readFile.mockRejectedValueOnce(new Error("permission revoked")); await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.queryByRole("alert")).toBeNull();
    const pending = defer<string>(); m.readFile.mockReturnValueOnce(pending.promise);
    await act(async () => window.dispatchEvent(new Event("focus"))); click("锁定"); await screen.findByText(/已锁定。再次使用/);
    await act(async () => pending.resolve("remote-cipher")); expect(screen.queryByText("同步文件有更新")).toBeNull();
  });
  it("checks matching passwords, encrypts before download and caches ciphertext only", async () => {
    await mount(); click("创建加密文件"); fill("工作配置名称", "Home test"); fill("设置加密密码", password); fill("确认加密密码", "different-password");
    click("加密导出当前配置");
    expect((await screen.findByRole("alert")).textContent).toContain("两次加密密码不一致");
    expect(m.encrypt).not.toHaveBeenCalled();
    fill("确认加密密码", password); click("加密导出当前配置");
    await screen.findByText(/已生成加密下载文件/);
    expect(m.encrypt).toHaveBeenCalledWith(expect.objectContaining({ name: "Home test", state: captureWorkspace(initialState) }), password);
    expect(m.download).toHaveBeenCalledWith("new-ciphertext");
    expect(m.writeCache).toHaveBeenCalledWith("local:a", { encrypted: "new-ciphertext" });
    expect(m.ephemeral).toHaveBeenCalledWith(true);
    const original = m.encrypt.mock.calls[0][0];
    click("加密导出副本");
    await waitFor(() => expect(m.encrypt).toHaveBeenCalledTimes(2));
    expect(m.encrypt.mock.calls[1][0]).toBe(original);
    dirty(); click("加密导出副本");
    await waitFor(() => expect(m.encrypt).toHaveBeenCalledTimes(3));
    expect(m.encrypt.mock.calls[2][0].ancestors).toContain(original.revisionId);
  });

  it("unlocks the account cache, removes local subscription edit context and requires a password again after locking", async () => {
    m.readCache.mockResolvedValue({ encrypted: "cached-cipher" }); m.search = "editSubscriptionId=local-id";
    await mount(); await screen.findByRole("button", { name: "解锁上次配置" }); click("解锁上次配置"); await unlock();
    expect(m.decrypt).toHaveBeenCalledWith("cached-cipher", password); expect(m.replaceRoute).toHaveBeenCalledWith("/");
    click("锁定"); await screen.findByText(/已锁定。再次使用/);
    expect(m.clear).toHaveBeenCalledOnce();
    click("解锁上次配置"); expect((screen.getByLabelText(/^加密密码\s*\*?$/) as HTMLInputElement).value).toBe("");
    click("取消"); expect(screen.queryByLabelText(/^加密密码\s*\*?$/)).toBeNull();
  });

  it("retains unsaved edits when replacement or locking is declined", async () => {
    await mount(); await upload(); await unlock(); dirty();
    m.confirm.mockResolvedValue(false); click("锁定"); await waitFor(() => expect(m.confirm).toHaveBeenCalledOnce());
    expect(m.clear).not.toHaveBeenCalled();
    await upload(); fill("加密密码", password); click("解密并打开");
    await waitFor(() => expect(m.confirm).toHaveBeenCalledTimes(2));
    expect(m.replace).toHaveBeenCalledOnce();
    expect(useConfigStore.getState().mixedPort).toBe(17890);
    click("取消"); m.confirm.mockResolvedValue(true); click("锁定"); await screen.findByText(/已锁定。再次使用/);
    expect(m.clear).toHaveBeenCalledOnce();
  });

  it.each(["older", "diverged", "different"])("warns before replacing a %s workspace", async (relation) => {
    await mount(); await upload(); await unlock();
    const previous = incoming;
    incoming = relation === "different" ? nextWorkspace(previous.state, "Different") : relation === "older" ? { ...previous, revisionId: "ancestor", ancestors: [] } : { ...previous, revisionId: "parallel", ancestors: [] };
    if (relation === "older") previous.ancestors.push("ancestor");
    await upload(); await unlock();
    expect(m.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "确认切换工作配置", description: expect.stringContaining(relation === "older" ? "较旧版本" : relation === "diverged" ? "版本已分叉" : "另一份工作配置") }));
  });

  it("does not replace changes made while decryption is in progress", async () => {
    const pending = defer<WorkspaceDocument>(); m.decrypt.mockReturnValue(pending.promise);
    await mount(); await upload(); fill("加密密码", password); click("解密并打开");
    dirty(); await act(async () => pending.resolve(incoming));
    expect((await screen.findByRole("alert")).textContent).toContain("解密期间当前配置发生了变化"); expect(m.replace).not.toHaveBeenCalled();
  });

  it("discards pending decryption after switching accounts and clears memory-only state on unmount", async () => {
    const pending = defer<WorkspaceDocument>(); m.decrypt.mockReturnValue(pending.promise);
    const view = await mount(); await upload(); fill("加密密码", password); click("解密并打开");
    act(() => useUserStore.setState({ user: { id: "b" } as ReturnType<typeof useUserStore.getState>["user"] }));
    await act(async () => pending.resolve(incoming));
    expect(m.replace).not.toHaveBeenCalled(); expect(m.readCache).toHaveBeenLastCalledWith("local:b");
    m.memory = true; view.unmount(); expect(m.clear).toHaveBeenCalledOnce();
  });

  it("does not download or cache a save completed after an account switch", async () => {
    const pending = defer<string>(); m.encrypt.mockReturnValue(pending.promise);
    await mount(); click("创建加密文件"); fill("设置加密密码", password); fill("确认加密密码", password); click("加密导出当前配置");
    act(() => useUserStore.setState({ user: null }));
    await act(async () => pending.resolve("encrypted"));
    expect(m.download).not.toHaveBeenCalled(); expect(m.writeCache).not.toHaveBeenCalled();
    expect(m.readCache).toHaveBeenLastCalledWith("local:guest");
  });

  it.each([
    [new DOMException("cancelled", "AbortError"), "操作已取消"],
    [new DOMException("permission", "NotAllowedError"), "文件访问未授权"],
    [new DOMException("security", "SecurityError"), "文件访问未授权"],
    [new Error("Wrong password"), "Wrong password"],
    ["unknown", "操作失败，请重试"],
  ])("shows a safe error without replacing the editor: %s", async (error, message) => {
    m.pick.mockRejectedValue(error); await mount(); click("连接已有同步文件");
    expect((await screen.findByRole("alert")).textContent).toContain(message); expect(m.replace).not.toHaveBeenCalled();
  });

  it("links a file, detects remote changes, blocks overwrite and explicitly reads the newer revision", async () => {
    const selected = handle(); m.pick.mockResolvedValue(selected);
    await mount(); click("连接已有同步文件"); await screen.findByLabelText(/^加密密码\s*\*?$/); await unlock();
    expect(m.writeCache).toHaveBeenCalledWith("local:a", { encrypted: "cipher", handle: selected, linkedText: "cipher" });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    m.readFile.mockResolvedValue("remote-cipher");
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await screen.findByText("同步文件有更新");
    expect((screen.getByRole("button", { name: "加密保存到同步文件" }) as HTMLButtonElement).disabled).toBe(true);
    incoming = nextWorkspace(incoming.state, incoming.name, incoming);
    click("读取文件更新"); await waitFor(() => expect(m.decrypt).toHaveBeenCalledWith("remote-cipher", password));
    await waitFor(() => expect(screen.queryByText("同步文件有更新")).toBeNull());
    expect(m.authorize).toHaveBeenCalledWith(selected, "read");
    click("加密保存到同步文件"); await screen.findByText(/已加密保存到同步文件/);
    expect(m.authorize).toHaveBeenCalledWith(selected, "readwrite");
    expect(m.writeFile).toHaveBeenCalledWith(selected, "new-ciphertext", "remote-cipher");
  });

  it("refuses to overwrite an existing new-file destination and supports a fresh file", async () => {
    await mount(); await create();
    m.pickNew.mockResolvedValueOnce(handle("existing")); click("选择同步保存位置");
    expect((await screen.findByRole("alert")).textContent).toContain("该文件已有内容"); expect(m.writeFile).not.toHaveBeenCalled();
    const empty = handle(""); m.pickNew.mockResolvedValueOnce(empty); click("选择同步保存位置");
    await screen.findByText(/已加密保存到同步文件/);
    expect(m.writeFile).toHaveBeenCalledWith(empty, "new-ciphertext", "");
    click("加密导出副本"); await screen.findByText(/已生成加密下载文件/);
    expect(screen.getByText("同步文件：sync.subboost")).toBeTruthy();
  });

  it("falls back to ciphertext-only cache if a browser cannot clone file handles", async () => {
    m.writeCache.mockRejectedValueOnce(new Error("DataCloneError"));
    await mount(); click("连接已有同步文件"); await screen.findByLabelText(/^加密密码\s*\*?$/); await unlock();
    expect(m.writeCache).toHaveBeenLastCalledWith("local:a", { encrypted: "cipher" });
    m.writeCache.mockRejectedValue(new Error("QuotaExceeded")); click("加密导出副本");
    await screen.findByText(/浏览器未能记住副本/); expect(m.download).toHaveBeenCalledWith("new-ciphertext");
  });

  it("protects dirty drafts on unload and navigation, while allowing same-page links", async () => {
    await mount(); await upload(); await unlock(); dirty();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const unload = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true);
    const link = document.createElement("a"); link.href = "/dashboard"; document.body.append(link);
    const navigation = new MouseEvent("click", { bubbles: true, cancelable: true }); link.dispatchEvent(navigation); expect(navigation.defaultPrevented).toBe(true); expect(confirm).toHaveBeenCalledOnce();
    link.href = "#same-page";
    link.addEventListener("click", (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(confirm).toHaveBeenCalledOnce();
    link.href = "/dashboard"; link.target = "_blank";
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(confirm).toHaveBeenCalledOnce();
    link.target = ""; link.download = "fixture";
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(confirm).toHaveBeenCalledOnce();
    link.removeAttribute("download");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })); expect(confirm).toHaveBeenCalledOnce();
    document.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(confirm).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); expect(confirm).toHaveBeenCalledTimes(2);
    link.remove();
  });

  it("supports import/export-only browsers, handles empty file selections and clears cancelled form fields", async () => {
    m.fileAccess = false; m.readCache.mockRejectedValue(new Error("storage disabled"));
    await mount(); expect(screen.queryByRole("button", { name: "连接已有同步文件" })).toBeNull();
    const input = screen.getByLabelText("选择加密工作配置文件"); const inputClick = vi.spyOn(input, "click");
    click("打开加密文件"); expect(inputClick).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [] } }); expect(m.readFile).not.toHaveBeenCalled();
    click("创建加密文件"); fill("设置加密密码", password); click("取消"); click("创建加密文件");
    expect((screen.getByLabelText(/^设置加密密码\s*\*?$/) as HTMLInputElement).value).toBe("");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
