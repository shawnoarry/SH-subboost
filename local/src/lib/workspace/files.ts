import { MAX_ENCRYPTED_FILE_BYTES } from "./crypto";

export type WorkspaceFileHandle = {
  name: string;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
};

type WorkspacePickerWindow = Window & {
  showOpenFilePicker?: (options: unknown) => Promise<WorkspaceFileHandle[]>;
  showSaveFilePicker?: (options: unknown) => Promise<WorkspaceFileHandle>;
};

const types = [{ description: "SubBoost 加密工作配置", accept: { "application/octet-stream": [".subboost"] } }];

export async function authorizeWorkspaceFile(handle: WorkspaceFileHandle, mode: "read" | "readwrite"): Promise<void> {
  if (handle.requestPermission && await handle.requestPermission({ mode }) !== "granted") throw new Error("文件访问未授权，请重新连接同步文件");
}

export function supportsWorkspaceFileAccess(): boolean {
  return typeof window !== "undefined" && Boolean((window as WorkspacePickerWindow).showOpenFilePicker && (window as WorkspacePickerWindow).showSaveFilePicker);
}

export async function pickWorkspaceFile(): Promise<WorkspaceFileHandle> {
  const picker = (window as WorkspacePickerWindow).showOpenFilePicker;
  if (!picker) throw new Error("请在 Chrome 或 Edge 中连接同步文件，或使用加密导入、导出");
  const [handle] = await picker.call(window, { multiple: false, types });
  if (!handle) throw new Error("未选择文件");
  return handle;
}

export async function pickNewWorkspaceFile(): Promise<WorkspaceFileHandle> {
  const picker = (window as WorkspacePickerWindow).showSaveFilePicker;
  if (!picker) throw new Error("浏览器不支持直接保存，请使用加密导出");
  return picker.call(window, { suggestedName: "subboost-workspace.subboost", types });
}

export async function readWorkspaceFile(file: Pick<File, "size" | "text">): Promise<string> {
  if (file.size > MAX_ENCRYPTED_FILE_BYTES) throw new Error("加密文件过大");
  return file.text();
}

export async function writeWorkspaceFile(handle: WorkspaceFileHandle, encrypted: string, expected: string): Promise<void> {
  const latest = await readWorkspaceFile(await handle.getFile());
  if (latest !== expected) throw new Error("同步文件已被其他电脑修改。请先读取更新；本地修改仍保留，可先导出为另一份加密文件。");
  const writer = await handle.createWritable();
  try { await writer.write(encrypted); await writer.close(); }
  catch (error) { await writer.abort().catch(() => undefined); throw error; }
}

export function downloadWorkspaceFile(encrypted: string): void {
  const url = URL.createObjectURL(new Blob([encrypted], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "subboost-workspace.subboost";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
