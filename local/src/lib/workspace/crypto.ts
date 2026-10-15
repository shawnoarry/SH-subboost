import { MAX_WORKSPACE_BYTES, validateWorkspaceDocument, type WorkspaceDocument } from "./snapshot";

export const WORKSPACE_FILE_FORMAT = "subboost-encrypted-workspace/v1";
export const WORKSPACE_KDF_ITERATIONS = 600000;
export const MAX_ENCRYPTED_FILE_BYTES = 23 * 1024 * 1024;
const encoder = new TextEncoder();
const aad = encoder.encode(WORKSPACE_FILE_FORMAT);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function unbase64(value: unknown, expectedLength?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("加密文件格式无效");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("加密文件格式无效"); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new Error("加密文件参数无效");
  return bytes;
}

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("浏览器不支持本地加密，请使用新版 Chrome 或 Edge 打开本机地址");
  return globalThis.crypto;
}

export function validateWorkspacePassword(password: string): void {
  if (password.trim().length < 12 || encoder.encode(password).length > 1024) throw new Error("加密密码至少 12 个字符，建议使用独立的长密码");
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  // Import accepts older/shorter passphrases for future format compatibility; new exports enforce strength.
  if (!password || encoder.encode(password).length > 1024) throw new Error("请输入加密密码");
  const subtle = webCrypto().subtle;
  const bytes = encoder.encode(password);
  try {
    const material = await subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey"]);
    return await subtle.deriveKey({ name: "PBKDF2", salt, iterations: WORKSPACE_KDF_ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { bytes.fill(0); }
}

export async function encryptWorkspace(document: WorkspaceDocument, password: string): Promise<string> {
  validateWorkspacePassword(password);
  const data = encoder.encode(JSON.stringify(validateWorkspaceDocument(document)));
  if (data.byteLength > MAX_WORKSPACE_BYTES) throw new Error("工作配置超过 16 MiB，请减少节点或导入源");
  const salt = webCrypto().getRandomValues(new Uint8Array(16));
  const iv = webCrypto().getRandomValues(new Uint8Array(12));
  try {
    const key = await deriveKey(password, salt);
    const ciphertext = await webCrypto().subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, data);
    return JSON.stringify({ format: WORKSPACE_FILE_FORMAT, kdf: "PBKDF2-SHA256", iterations: WORKSPACE_KDF_ITERATIONS, cipher: "AES-256-GCM", salt: base64(salt), iv: base64(iv), data: base64(new Uint8Array(ciphertext)) });
  } finally { data.fill(0); }
}

export async function decryptWorkspace(text: string, password: string): Promise<WorkspaceDocument> {
  if (text.length > MAX_ENCRYPTED_FILE_BYTES || encoder.encode(text).byteLength > MAX_ENCRYPTED_FILE_BYTES) throw new Error("加密文件过大");
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(text); } catch { throw new Error("请选择 SubBoost 导出的加密工作配置文件"); }
  if (!envelope || envelope.format !== WORKSPACE_FILE_FORMAT || envelope.kdf !== "PBKDF2-SHA256" || envelope.iterations !== WORKSPACE_KDF_ITERATIONS || envelope.cipher !== "AES-256-GCM") throw new Error("不支持的加密文件格式或版本");
  const salt = unbase64(envelope.salt, 16);
  const iv = unbase64(envelope.iv, 12);
  const ciphertext = unbase64(envelope.data);
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_WORKSPACE_BYTES + 16) throw new Error("加密文件内容长度无效");
  const key = await deriveKey(password, salt);
  let cleartext: ArrayBuffer;
  try {
    cleartext = await webCrypto().subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad, tagLength: 128 }, key, ciphertext);
  } catch { throw new Error("密码不正确，或文件已损坏、被修改"); }
  const bytes = new Uint8Array(cleartext);
  try { return validateWorkspaceDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  finally { bytes.fill(0); }
}
