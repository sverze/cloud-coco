import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import type { ContextPack, ConversationEntry } from "./types.ts";

const MEMORY_ROOT = "/memory";
const CONVERSATIONS_DIR = `${MEMORY_ROOT}/conversations`;
const CONTEXT_PACK_PATH = `${MEMORY_ROOT}/context-pack.json.enc`;

// AES-256-GCM layout: [12-byte IV][16-byte authTag][ciphertext]
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export const EMPTY_CONTEXT_PACK: ContextPack = {
  version: "0.0",
  generated: new Date(0).toISOString(),
  identity: {
    name: "User",
    timezone: "America/Los_Angeles",
    communication_style: "direct",
  },
  active_goals: [],
  preferences: {},
  recent_summary: "No context pack available. Run sync to load PAI memory.",
  last_sync: new Date(0).toISOString(),
};

export function encryptContextPack(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export async function loadContextPack(key: Buffer): Promise<ContextPack> {
  const start = Date.now();
  try {
    const raw = await Bun.file(CONTEXT_PACK_PATH).arrayBuffer();
    const buf = Buffer.from(raw);

    if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      console.warn("[memory] context pack too small, using empty context");
      return EMPTY_CONTEXT_PACK;
    }

    const iv = buf.subarray(0, IV_LENGTH);
    const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");

    const pack = JSON.parse(plaintext) as ContextPack;
    const elapsed = Date.now() - start;
    console.log(`[memory] context pack loaded in ${elapsed}ms, generated: ${pack.generated}`);
    return pack;
  } catch (err) {
    const elapsed = Date.now() - start;
    console.warn(`[memory] context pack load failed in ${elapsed}ms (${(err as Error).message}), using empty context`);
    return EMPTY_CONTEXT_PACK;
  }
}

function dateString(offset = 0): string {
  const d = new Date();
  if (offset !== 0) d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(d);
}

function logPath(dateStr: string): string {
  return `${CONVERSATIONS_DIR}/${dateStr}.jsonl`;
}

async function readEntries(dateStr: string): Promise<ConversationEntry[]> {
  try {
    const text = await readFile(logPath(dateStr), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ConversationEntry);
  } catch {
    return [];
  }
}

export async function loadConversationWindow(): Promise<ConversationEntry[]> {
  const todayStr = dateString(0);
  const yesterdayStr = dateString(-1);

  const todayEntries = await readEntries(todayStr);
  const window = todayEntries.slice(-20);

  if (todayEntries.length < 5) {
    const yesterdayEntries = await readEntries(yesterdayStr);
    const yesterdayWindow = yesterdayEntries.slice(-10);
    return [...yesterdayWindow, ...window];
  }

  return window;
}

export async function appendConversationEntry(entry: ConversationEntry): Promise<void> {
  try {
    await mkdir(CONVERSATIONS_DIR, { recursive: true });
    const line = JSON.stringify(entry) + "\n";
    await appendFile(logPath(dateString(0)), line, "utf8");
  } catch (err) {
    console.error(`[memory] failed to append conversation entry: ${(err as Error).message}`);
  }
}
