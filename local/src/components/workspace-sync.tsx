"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileLock2, FolderSync, LockKeyhole } from "lucide-react";
import { Button } from "@subboost/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@subboost/ui/components/ui/dialog";
import { FormField } from "@subboost/ui/components/ui/form-field";
import { Input } from "@subboost/ui/components/ui/input";
import { PasswordField } from "@subboost/ui/components/ui/password-field";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { setConfigDraftEphemeral, useConfigStore } from "@subboost/ui/store/config-store";
import { isConfigDraftMemoryOnly } from "@subboost/ui/store/config-store/draft-privacy";
import { initialState } from "@subboost/ui/store/config-store/definitions";
import { useUserStore } from "@subboost/ui/store/user-store";
import { captureWorkspace, compareWorkspace, nextWorkspace, type WorkspaceDocument } from "@local/lib/workspace/snapshot";
import { decryptWorkspace, encryptWorkspace, validateWorkspacePassword } from "@local/lib/workspace/crypto";
import { authorizeWorkspaceFile, downloadWorkspaceFile, pickNewWorkspaceFile, pickWorkspaceFile, readWorkspaceFile, supportsWorkspaceFileAccess, writeWorkspaceFile, type WorkspaceFileHandle } from "@local/lib/workspace/files";
import { readWorkspaceCache, writeWorkspaceCache, type WorkspaceCache } from "@local/lib/workspace/cache";
import { clearWorkspaceEditor, replaceWorkspaceEditor } from "@local/lib/workspace/editor";

type Session = { document: WorkspaceDocument; baseline: string; encrypted: string; handle?: WorkspaceFileHandle; linkedText?: string };
type Pending = { encrypted: string; handle?: WorkspaceFileHandle; linkedText?: string };

function draftText(): string { return JSON.stringify(captureWorkspace(useConfigStore.getState())); }
function getCurrentScope(): string { return `local:${useUserStore.getState().user?.id ?? "guest"}`; }
function hasContent(): boolean {
  const snapshot = captureWorkspace(useConfigStore.getState());
  const empty = captureWorkspace(initialState);
  return JSON.stringify({ ...snapshot, sources: snapshot.sources.filter((source) => source.content.trim()) }) !== JSON.stringify({ ...empty, sources: [] });
}

function errorText(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") return "操作已取消，原配置保持不变";
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "文件访问未授权，请重新连接同步文件";
  }
  return error instanceof Error ? error.message : "操作失败，请重试";
}

export function WorkspaceSync() {
  const store = useConfigStore();
  const userId = useUserStore((state) => state.user?.id ?? "guest");
  const userLoading = useUserStore((state) => state.isLoading);
  const router = useRouter();
  const searchParams = useSearchParams();
  const scope = `local:${userId}`;
  const passwordRef = React.useRef("");
  const fileInput = React.useRef<HTMLInputElement>(null);
  const busyRef = React.useRef(false);
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"manage" | "unlock" | "create">("manage");
  const [session, setSession] = React.useState<Session | null>(null);
  const [cached, setCached] = React.useState<WorkspaceCache | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [password, setPassword] = React.useState("");
  const [passwordConfirm, setPasswordConfirm] = React.useState("");
  const [name, setName] = React.useState("我的配置");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState("");
  const [fileAccess, setFileAccess] = React.useState(false);
  const [remoteChanged, setRemoteChanged] = React.useState(false);
  const serialized = React.useMemo(() => JSON.stringify(captureWorkspace(store)), [store]);
  const dirty = Boolean(session && serialized !== session.baseline);

  React.useEffect(() => {
    let cancelled = false;
    passwordRef.current = "";
    setPassword(""); setPasswordConfirm(""); setSession(null); setPending(null); setCached(null);
    setError(""); setMessage(""); setRemoteChanged(false); setMode("manage");
    setFileAccess(supportsWorkspaceFileAccess());
    void readWorkspaceCache(scope).then((cache) => { if (!cancelled) setCached(cache); }).catch(() => {});
    return () => {
      cancelled = true; passwordRef.current = "";
      if (isConfigDraftMemoryOnly()) clearWorkspaceEditor();
    };
  }, [scope]);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const warnNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, location.href);
      if (destination.origin === location.origin && destination.pathname === location.pathname && destination.search === location.search) return;
      if (!window.confirm("还有未加密保存的修改。离开首页会丢失这些修改，确定继续吗？")) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", warnNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", warnNavigation, true);
    };
  }, [dirty]);

  React.useEffect(() => {
    if (!session?.handle) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking || busyRef.current || document.visibilityState !== "visible") return;
      checking = true;
      try {
        const text = await readWorkspaceFile(await session.handle!.getFile());
        if (active) setRemoteChanged(text !== session.linkedText);
      } catch { /* A saved browser handle may need the user to grant access again. */ }
      finally { checking = false; }
    };
    window.addEventListener("focus", check);
    const interval = setInterval(check, 15000);
    void check();
    return () => { active = false; clearInterval(interval); window.removeEventListener("focus", check); };
  }, [session]);

  const run = async (operation: (operationScope: string) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setMessage("");
    try { await operation(scope); }
    catch (cause) { if (getCurrentScope() === scope) setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const remember = async (next: Session, operationScope: string) => {
    const cache = { encrypted: next.encrypted, ...(next.handle ? { handle: next.handle, linkedText: next.linkedText } : {}) };
    setCached(cache);
    try { await writeWorkspaceCache(operationScope, cache); }
    catch {
      // Some browsers cannot clone file handles; still keep a password-protected local backup.
      try { await writeWorkspaceCache(operationScope, { encrypted: next.encrypted }); }
      catch { if (getCurrentScope() === operationScope) setMessage("加密文件已准备好，但浏览器未能记住副本。下次请重新打开文件。"); }
    }
  };

  const apply = async (input: Pending, passphrase: string, operationScope: string) => {
    if (useConfigStore.getState().isLoading) throw new Error("请等待当前订阅导入完成，再读取工作配置");
    const before = draftText();
    const revision = useConfigStore.getState().draftRevision;
    const incoming = await decryptWorkspace(input.encrypted, passphrase);
    if (getCurrentScope() !== operationScope) return;
    const relationship = session ? compareWorkspace(session.document, incoming) : null;
    const conflict = relationship === "older" ? "这是较旧版本。" : relationship === "diverged" ? "两台电脑分别修改过配置，版本已分叉。" : relationship === "different" ? "这是另一份工作配置。" : "";
    if (conflict || dirty || (!session && hasContent())) {
      const accepted = await confirmDialog({
        title: conflict ? "确认切换工作配置" : "当前编辑内容将被替换",
        description: `${conflict}${dirty || hasContent() ? "建议先取消并加密导出当前版本。" : ""}继续后会载入“${incoming.name}”（${new Date(incoming.updatedAt).toLocaleString()}），替换当前编辑器中的来源、节点和规则。本机账号和数据库中已保存的订阅不受影响。`,
        confirmText: "替换当前编辑内容", cancelText: "取消，保留当前内容", variant: "warning",
      });
      if (!accepted) return;
    }
    if (getCurrentScope() !== operationScope) return;
    if (draftText() !== before || useConfigStore.getState().draftRevision !== revision) throw new Error("解密期间当前配置发生了变化，请重试。原配置保持不变。");
    replaceWorkspaceEditor(incoming.state);
    if (searchParams.has("editSubscriptionId")) router.replace("/");
    const next: Session = { document: incoming, baseline: draftText(), encrypted: input.encrypted, handle: input.handle, linkedText: input.linkedText };
    passwordRef.current = passphrase;
    setSession(next); setPending(null); setPassword(""); setPasswordConfirm(""); setMode("manage"); setRemoteChanged(false);
    setMessage("已在本机解密并载入工作配置，可以继续编辑和生成 YAML。");
    await remember(next, operationScope);
  };

  const openFile = async (file: File) => run(async (operationScope) => {
    const encrypted = await readWorkspaceFile(file);
    if (getCurrentScope() !== operationScope) return;
    setPending({ encrypted }); setPassword(""); setMode("unlock");
  });

  const connect = () => run(async (operationScope) => {
    // Pickers run directly from this click, before any crypto work consumes user activation.
    const handle = await pickWorkspaceFile();
    const encrypted = await readWorkspaceFile(await handle.getFile());
    if (getCurrentScope() !== operationScope) return;
    setPending({ encrypted, handle, linkedText: encrypted }); setPassword(""); setMode("unlock");
  });

  const save = (destination: "download" | "linked" | "new-file", passphrase = passwordRef.current, workspaceName = session?.document.name ?? name) => run(async (operationScope) => {
    if (useConfigStore.getState().isLoading) throw new Error("请等待当前订阅导入完成，再加密保存");
    validateWorkspacePassword(passphrase);
    if (mode === "create" && passphrase !== passwordConfirm) throw new Error("两次加密密码不一致");
    const handle = destination === "new-file" ? await pickNewWorkspaceFile() : destination === "linked" ? session?.handle : undefined;
    if (handle) await authorizeWorkspaceFile(handle, "readwrite");
    const expected = destination === "new-file" ? "" : session?.linkedText ?? "";
    if (destination === "new-file" && (await handle!.getFile()).size !== 0) throw new Error("该文件已有内容。请先连接并解锁它，或选择一个新文件名，避免覆盖其他版本。");
    const state = captureWorkspace(useConfigStore.getState());
    const baseline = JSON.stringify(state);
    const document = session && baseline === session.baseline ? session.document : nextWorkspace(state, workspaceName, session?.document);
    const encrypted = await encryptWorkspace(document, passphrase);
    if (getCurrentScope() !== operationScope) return;
    if (destination !== "download") {
      if (!handle) throw new Error("请先连接一个同步文件");
      await writeWorkspaceFile(handle, encrypted, expected);
    } else downloadWorkspaceFile(encrypted);
    if (getCurrentScope() !== operationScope) return;
    setConfigDraftEphemeral(true);
    const next: Session = {
      document, baseline, encrypted,
      handle: destination === "download" ? session?.handle : handle,
      linkedText: destination === "download" ? session?.linkedText : encrypted,
    };
    passwordRef.current = passphrase;
    setSession(next); setPassword(""); setPasswordConfirm(""); setMode("manage");
    if (destination !== "download") setRemoteChanged(false);
    setMessage(destination === "download" ? "已生成加密下载文件，请确认下载完成后再换电脑。" : "已加密保存到同步文件。请等待同步软件完成上传后再换电脑。");
    await remember(next, operationScope);
  });

  const loadLatest = () => run(async (operationScope) => {
    if (!session?.handle) return;
    await authorizeWorkspaceFile(session.handle, "read");
    const encrypted = await readWorkspaceFile(await session.handle.getFile());
    await apply({ encrypted, handle: session.handle, linkedText: encrypted }, passwordRef.current, operationScope);
  });

  const lock = () => run(async (operationScope) => {
    if (dirty && !await confirmDialog({ title: "还有未加密保存的修改", description: "锁定会清空当前编辑器。请先取消并保存；继续后只能恢复上次加密保存的版本。", confirmText: "放弃未保存修改并锁定", variant: "warning" })) return;
    if (getCurrentScope() !== operationScope) return;
    passwordRef.current = ""; setSession(null); setPending(null); setPassword(""); setPasswordConfirm("");
    clearWorkspaceEditor();
    if (searchParams.has("editSubscriptionId")) router.replace("/");
    setMessage("已锁定。再次使用时需要加密密码。");
  });

  const disabled = busy || userLoading || store.isLoading;
  return (
    <div className="mb-3 rounded-xl border border-ink/10 bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <FileLock2 className="h-4 w-4 shrink-0 text-fg-60" aria-hidden="true" />
          <span className="truncate font-medium">{session?.document.name ?? "本机工作配置"}</span>
          <span className="text-xs text-fg-50">{session ? dirty ? "有未保存修改" : "已加密保存" : cached ? "已锁定" : "两台电脑独立运行"}</span>
          {remoteChanged && <span className="text-xs text-amber-500">同步文件有更新</span>}
        </div>
        <Button size="sm" variant="outline" onClick={() => { setOpen(true); setMode("manage"); setError(""); }}><FolderSync aria-hidden="true" />加密同步</Button>
      </div>
      <input ref={fileInput} type="file" accept=".subboost" className="hidden" aria-label="选择加密工作配置文件" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void openFile(file); }} />
      <Dialog open={open} onOpenChange={(value) => { if (!busy) { setOpen(value); setPassword(""); setPasswordConfirm(""); if (!value) { setPending(null); setMode("manage"); } } }}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>加密工作配置</DialogTitle>
            <DialogDescription>把同一加密文件放进同步文件夹，在家和办公室接着编辑。换电脑时先读取最新文件，每次只在一台电脑编辑。</DialogDescription>
          </DialogHeader>
          <p className="text-xs leading-relaxed text-fg-50">包含订阅源、节点、删除与筛选记录、代理组、分流和 DNS。加解密在本机浏览器完成；密码不上传、不保存，与本机登录密码无关。</p>
          {mode === "unlock" && pending ? (
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void run((operationScope) => apply(pending, password, operationScope)); }}>
              <PasswordField label="加密密码" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={disabled || !password}>{busy ? "正在解密…" : "解密并打开"}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setPending(null); setPassword(""); setMode("manage"); }}>取消</Button>
              </div>
            </form>
          ) : mode === "create" ? (
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save("download", password, name); }}>
              <FormField label="工作配置名称"><Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy} /></FormField>
              <PasswordField label="设置加密密码" description="至少 12 个字符。两台电脑使用同一个加密密码，请自行保管；忘记后无法恢复文件。" autoComplete="off" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />
              <PasswordField label="确认加密密码" autoComplete="off" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} required disabled={busy} />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={disabled || !name.trim() || !password || !passwordConfirm}>{busy ? "正在加密…" : "加密导出当前配置"}</Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => { setMode("manage"); setPassword(""); setPasswordConfirm(""); }}>取消</Button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              {session ? (
                <>
                  <div className="rounded-xl border border-ink/10 bg-ink/5 p-3 text-sm">
                    <p className="font-medium">{session.document.name}</p>
                    <p className="mt-1 text-xs text-fg-50">{store.sources.filter((source) => source.content.trim()).length} 个来源 · {store.nodes.length} 个节点 · {dirty ? "有未加密保存的修改" : "与上次加密保存一致"}</p>
                    <p className="mt-1 text-xs text-fg-50">版本时间：{new Date(session.document.updatedAt).toLocaleString()}</p>
                    {session.handle && <p className="mt-1 break-all text-xs text-fg-60">同步文件：{session.handle.name}</p>}
                  </div>
                  {remoteChanged && <p className="text-sm text-amber-500" role="status">同步文件有变化，请先读取更新。若两边都有修改，先加密导出本地副本，再决定使用哪个版本。</p>}
                  <div className="flex flex-wrap gap-2">
                    {session.handle && <Button disabled={disabled || remoteChanged} onClick={() => void save("linked")}>{busy ? "正在处理…" : "加密保存到同步文件"}</Button>}
                    {session.handle && <Button variant="outline" disabled={disabled} onClick={loadLatest}>读取文件更新</Button>}
                    <Button variant={session.handle ? "outline" : "default"} disabled={disabled} onClick={() => void save("download")}>加密导出副本</Button>
                    {fileAccess && !session.handle && <Button variant="outline" disabled={disabled} onClick={() => void save("new-file")}>选择同步保存位置</Button>}
                    <Button variant="outline" disabled={disabled} onClick={lock}><LockKeyhole aria-hidden="true" />锁定</Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-fg-70">第一次使用：先导入订阅并调整配置，再创建加密文件。另一台电脑打开这个文件即可继续。</p>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={disabled} onClick={() => { setMode("create"); setPassword(""); setPasswordConfirm(""); }}>创建加密文件</Button>
                    {cached && <Button variant="outline" disabled={disabled} onClick={() => { setPending(cached); setMode("unlock"); setPassword(""); }}>解锁上次配置</Button>}
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-2 border-t border-ink/10 pt-4">
                <Button variant="outline" disabled={disabled} onClick={() => fileInput.current?.click()}>打开加密文件</Button>
                {fileAccess && <Button variant="outline" disabled={disabled} onClick={connect}>连接已有同步文件</Button>}
              </div>
              <p className="text-xs leading-relaxed text-fg-50">{fileAccess ? "可选择同步文件夹内的文件直接读写。同步软件负责跨电脑传输，SubBoost 不会自动覆盖其他电脑的新版本。" : "此浏览器使用加密导出、导入。若要直接读写同步文件，请用新版 Chrome 或 Edge 打开同一本机地址。"} 只同步 .subboost 文件，不要同步数据库或 .env。</p>
              <p className="text-xs leading-relaxed text-fg-50">锁定、关闭或离开首页后需要重新输入密码；未保存的修改不会自动备份。如需生成本机订阅链接，请先登录，再解锁工作配置并保存。</p>
            </div>
          )}
          {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
          {message && <p className="text-sm text-fg-70" role="status">{message}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
