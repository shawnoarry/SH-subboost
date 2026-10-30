"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@subboost/ui/components/ui/button";
import { Input } from "@subboost/ui/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@subboost/ui/components/ui/card";
import { confirmDialog } from "@subboost/ui/components/ui/confirm-dialog";
import { readJsonResponse } from "@subboost/ui/product/client-response";
import type { MaintenanceState, NodeTestJob, NodeTestResult, NodeTestStatus, UpdatePreview } from "@subboost/core/subscription/maintenance";

const STATUS: Record<NodeTestStatus, string> = { queued: "等待检测", testing: "检测中", available: "可连接", timeout: "超时", failed: "连接失败", unsupported: "暂不支持", cancelled: "已取消" };
const CHANGE = { added: "新增", removed: "移除", changed: "参数变化", renamed: "改名" };

export function SubscriptionMaintenance({ subscriptionId }: { subscriptionId: string }) {
  const endpoint = `/api/subscriptions/${encodeURIComponent(subscriptionId)}/maintenance`;
  const [state, setState] = React.useState<MaintenanceState | null>(null);
  const [preview, setPreview] = React.useState<UpdatePreview>();
  const [view, setView] = React.useState<"saved" | "preview">("saved");
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [job, setJob] = React.useState<{ value: NodeTestJob; scope: string }>();
  const [results, setResults] = React.useState<Record<string, Record<string, NodeTestResult>>>({});
  const running = job?.value.status === "running";
  const nodes = view === "preview" && preview ? preview.nodes : state?.nodes ?? [];
  const scope = `${state?.version}:${view === "preview" ? preview?.id : "saved"}`;
  const visible = nodes.filter((node) => `${node.name} ${node.type} ${node.source}`.toLowerCase().includes(search.toLowerCase()));

  const load = React.useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const data = await readJsonResponse<MaintenanceState>(response, "无法加载订阅，请确认已登录");
    setState(data); setPreview(data.preview); setSelected(new Set());
  }, [endpoint]);
  React.useEffect(() => { void load().catch((error: Error) => setError(error.message)); }, [load]);

  const action = async <T,>(body: Record<string, unknown>) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return readJsonResponse<T>(response, "操作失败，请稍后重试");
  };

  React.useEffect(() => {
    if (!job || job.value.status !== "running") return;
    let cancelled = false;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`${endpoint}?job=${encodeURIComponent(job.value.id)}`, { signal: abort.signal, cache: "no-store" });
        const data = await readJsonResponse<{ job: NodeTestJob }>(response, "无法读取检测进度");
        if (cancelled) return;
        setResults((previous) => ({ ...previous, [job.scope]: { ...previous[job.scope], ...Object.fromEntries(data.job.results.map((row) => [row.id, row])) } }));
        if (data.job.status !== "running") setJob({ value: data.job, scope: job.scope });
        else timer = setTimeout(() => { void poll(); }, 800);
      } catch (error) {
        if (!cancelled) { setError(error instanceof Error ? error.message : "无法读取检测进度"); setJob(undefined); }
      }
    };
    void poll();
    return () => { cancelled = true; abort.abort(); clearTimeout(timer); };
  }, [endpoint, job]);

  async function checkUpdates() {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await action<{ preview: UpdatePreview }>({ action: "check" });
      setPreview(data.preview); setView("preview"); setSelected(new Set());
      setNotice("检查完成。以下内容尚未应用，请查看变化并按需检测候选节点。");
    } catch (error) { setError(error instanceof Error ? error.message : "检查失败"); }
    finally { setBusy(false); }
  }

  async function applyUpdate() {
    if (!preview) return;
    const confirmed = await confirmDialog({ title: "应用这次预览的更新？", description: `${preview.beforeCount} → ${preview.afterCount} 个节点。${preview.message ?? ""}将更新此订阅的已保存内容，订阅链接保持不变。`, confirmText: "应用更新" });
    if (!confirmed) return;
    setBusy(true); setError("");
    try {
      await action({ action: "apply", previewId: preview.id });
      await load(); setView("saved"); setNotice("更新已保存，原订阅链接保持不变。需要使用时，请自行在 Clash 更新这条订阅。");
    } catch (error) { setError(error instanceof Error ? error.message : "应用失败"); }
    finally { setBusy(false); }
  }

  async function testNodes(ids: string[]) {
    if (!state) return;
    setBusy(true); setError("");
    try {
      const data = await action<{ job: NodeTestJob }>({ action: "start-test", nodeIds: ids, version: state.version, ...(view === "preview" && preview ? { previewId: preview.id } : {}) });
      setJob({ value: data.job, scope });
      setResults((previous) => ({ ...previous, [scope]: { ...previous[scope], ...Object.fromEntries(data.job.results.map((row) => [row.id, row])) } }));
    } catch (error) { setError(error instanceof Error ? error.message : "检测失败"); }
    finally { setBusy(false); }
  }

  async function cancelTests() {
    if (!job) return;
    setBusy(true);
    try { await action({ action: "cancel-test", jobId: job.value.id }); }
    catch (error) { setError(error instanceof Error ? error.message : "取消失败"); }
    finally { setBusy(false); }
  }

  async function enableConfirmationMode() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ autoUpdateInterval: null }) });
      await readJsonResponse(response, "无法关闭自动更新");
      await load(); setNotice("已关闭此订阅的自动更新。此后检查结果需要你确认应用。");
    } catch (error) { setError(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  return <div className="container mx-auto max-w-6xl space-y-6 px-4 py-8">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><Link href="/dashboard" className="text-sm text-fg-50 hover:text-fg">返回我的订阅</Link><h1 className="mt-2 text-2xl font-bold">{state?.subscription.name ?? "订阅"} · 更新与检测</h1><p className="mt-2 text-sm text-fg-50">先检查订阅变化，按需检测节点，确认后再保存更新。</p></div>
      <Button onClick={() => void checkUpdates()} disabled={!state || busy || running || Boolean(state.subscription.autoUpdateInterval)}>{busy ? "处理中…" : "检查订阅更新"}</Button>
    </div>
    {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-fg">{error} {!state && <Link href="/login" className="underline">前往登录</Link>}</div>}
    {notice && <div role="status" className="rounded-xl border border-ink/10 bg-ink/5 p-4 text-sm text-fg">{notice}</div>}
    {Boolean(state?.subscription.autoUpdateInterval) && <Card><CardContent className="space-y-3 pt-6"><p className="text-sm text-fg-70">此订阅仍启用了自动更新。逐次预览确认需要先关闭自动更新，避免后台刷新覆盖待确认的内容。</p><Button variant="outline" onClick={() => void enableConfirmationMode()} disabled={busy || running}>改为确认后更新</Button></CardContent></Card>}
    {preview && <Card>
      <CardHeader><CardTitle>更新预览 · 尚未应用</CardTitle><p className="text-sm text-fg-50">{new Date(preview.checkedAt).toLocaleString()} 检查 · {preview.beforeCount} → {preview.afterCount} 个节点 · 预览保留 15 分钟</p></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 text-sm">{(Object.keys(CHANGE) as (keyof typeof CHANGE)[]).map((kind) => <span key={kind} className="rounded-lg bg-ink/5 px-3 py-2">{CHANGE[kind]} {preview.changes.filter((change) => change.kind === kind).length}</span>)}<span className="px-3 py-2 text-fg-50">未变 {preview.unchangedCount}</span></div>
        <ul className="space-y-1 text-sm text-fg-70">{preview.sources.map((source, index) => <li key={index}>{source.name}：{source.status === "updated" ? "获取成功" : source.status === "failed" ? "获取失败" : "由 Clash 管理"}{source.message ? `；${source.message}` : ""}</li>)}</ul>
        {preview.message && <p className="text-sm text-fg-70">{preview.message}</p>}
        {preview.changes.length ? <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-ink/10 p-3">{preview.changes.map((change, index) => <div key={index} className="text-sm"><span className="mr-2 text-fg-50">{CHANGE[change.kind]}</span>{change.previousName ? `${change.previousName} → ` : ""}{change.name}{change.fields.length > 0 && <span className="ml-2 text-xs text-fg-50">变化字段：{change.fields.join("、")}</span>}</div>)}</div> : <p className="text-sm text-fg-50">节点内容没有变化。订阅流量、到期等信息仍可随确认更新。</p>}
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-fg-50">应用会保存本次预览的内容，不会再次拉取订阅。</p><Button onClick={() => void applyUpdate()} disabled={!preview.canApply || busy || running}>确认应用更新</Button></div>
      </CardContent>
    </Card>}
    <Card>
      <CardHeader><CardTitle>节点检测</CardTitle><p className="text-sm text-fg-50">通过独立检测进程访问小体积测试页面。结果反映当前连通性与延迟，不代表下载速度、AI 可用性或 IP 信誉。</p></CardHeader>
      <CardContent className="space-y-4">
        {state?.engine.message && <p role="status" className="text-sm text-fg-70">{state.engine.message}</p>}
        {state?.engine.interfaceName && <p className="text-xs text-fg-50">检测网卡：{state.engine.interfaceName} · 并发 3 · 单节点超时 5 秒 · 单批最多 200 个节点 · 不切换 Clash 代理组</p>}
        <div className="flex flex-wrap items-center gap-2"><Button variant={view === "saved" ? "default" : "outline"} disabled={running} onClick={() => { setView("saved"); setSelected(new Set()); }}>已保存节点 ({state?.nodes.length ?? 0})</Button>{preview && <Button variant={view === "preview" ? "default" : "outline"} disabled={running} onClick={() => { setView("preview"); setSelected(new Set()); }}>候选节点 ({preview.nodes.length})</Button>}</div>
        <div className="flex flex-wrap items-center gap-3"><Input aria-label="搜索节点" placeholder="搜索节点名称、来源或协议" value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-48 flex-1"/><Button variant="outline" onClick={() => setSelected(new Set(visible.slice(0, 200).map((node) => node.id)))} disabled={running}>选择当前结果（最多 200）</Button><Button onClick={() => void testNodes([...selected])} disabled={!selected.size || busy || running || !state?.engine.available}>检测已选 ({selected.size})</Button>{running && <Button variant="outline" disabled={busy} onClick={() => void cancelTests()}>停止检测</Button>}</div>
        {job && <p role="status" className="text-sm text-fg-50">{job.value.status === "running" ? "检测进行中" : job.value.status === "cancelled" ? "检测已停止" : "检测完成"} · 已完成 {Object.values(results[job.scope] ?? {}).filter((result) => !["queued", "testing"].includes(result.status)).length} / {job.value.results.length}</p>}
        <div className="max-h-[32rem] overflow-auto rounded-xl border border-ink/10"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-surface-raised text-fg-50"><tr><th className="p-3">选择 / 节点</th><th className="p-3">检测结果</th><th className="p-3">操作</th></tr></thead><tbody>{visible.map((node) => {
          const result = results[scope]?.[node.id];
          return <tr key={node.id} className="border-t border-ink/10"><td className="p-3"><label className="flex items-start gap-3"><input type="checkbox" aria-label={`选择 ${node.name}`} checked={selected.has(node.id)} disabled={running} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(node.id); else next.delete(node.id); return next; })}/><span className="break-words">{node.name}<span className="mt-1 block text-xs text-fg-50">{node.source} · {node.type}</span></span></label></td><td className="p-3"><span>{result ? `${STATUS[result.status]}${result.delay !== undefined ? ` · ${result.delay} ms` : ""}` : "未检测"}</span>{result?.message && <span className="mt-1 block text-xs text-fg-50">{result.message}</span>}{result?.checkedAt && <time className="mt-1 block text-xs text-fg-50">{new Date(result.checkedAt).toLocaleTimeString()}</time>}</td><td className="p-3"><Button size="sm" variant="outline" disabled={busy || running || !state?.engine.available} onClick={() => void testNodes([node.id])}>检测</Button></td></tr>;
        })}</tbody></table>{!visible.length && <p className="p-6 text-sm text-fg-50">没有匹配的节点；由 Clash 管理的订阅源需要在客户端展开检测。</p>}</div>
      </CardContent>
    </Card>
  </div>;
}
