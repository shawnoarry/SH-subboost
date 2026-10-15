// An unlocked encrypted workspace must not enter the ordinary plaintext draft caches.
// This flag is page-memory only and defaults to the existing draft behavior.
let memoryOnly = false;

export function isConfigDraftMemoryOnly(): boolean { return memoryOnly; }
export function setConfigDraftMemoryOnly(value: boolean): void { memoryOnly = value; }
