import type { WorkspaceFileHandle } from "./files";

export type WorkspaceCache = { encrypted: string; handle?: WorkspaceFileHandle; linkedText?: string };

// Browser-local cache contains ciphertext and a file handle only. Never store passwords or cleartext.
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("subboost-encrypted-workspace", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspaces");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("浏览器无法保存加密副本"));
  });
}

export async function readWorkspaceCache(scope: string): Promise<WorkspaceCache | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("workspaces", "readonly");
      const request = transaction.objectStore("workspaces").get(scope);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(new Error("无法读取加密副本"));
    });
  } finally { db.close(); }
}

export async function writeWorkspaceCache(scope: string, cache: WorkspaceCache): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("workspaces", "readwrite");
      transaction.objectStore("workspaces").put(cache, scope);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("无法保存加密副本"));
      transaction.onabort = () => reject(new Error("无法保存加密副本"));
    });
  } finally { db.close(); }
}
