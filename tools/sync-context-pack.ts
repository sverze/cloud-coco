/**
 * sync-context-pack.ts — MacBook push script
 *
 * Reads live PAI memory files, distils them to a context pack via Claude,
 * encrypts with AES-256-GCM, and uploads to GCS.
 *
 * Required env vars (or set in ~/.env.cloud-coco):
 *   CLAUDE_API_KEY   — Anthropic API key
 *   CONTEXT_PACK_KEY — 64 hex chars (same key as in GCP Secret Manager)
 *   GCS_BUCKET       — bucket name, e.g. cloud-coco-memory-abc123
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ── Env loading ────────────────────────────────────────────────────────────

async function loadEnvFile() {
  const path = `${process.env.HOME}/.env.cloud-coco`;
  try {
    const content = await readFile(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no file, that's fine
  }
}

await loadEnvFile();

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CONTEXT_PACK_KEY_HEX = process.env.CONTEXT_PACK_KEY;
const GCS_BUCKET = process.env.GCS_BUCKET;
const PAI_DIR = process.env.PAI_DIR ?? `${process.env.HOME}/.claude/PAI`;

if (!CLAUDE_API_KEY) throw new Error("CLAUDE_API_KEY is required");
if (!CONTEXT_PACK_KEY_HEX || CONTEXT_PACK_KEY_HEX.length !== 64) throw new Error("CONTEXT_PACK_KEY must be 64 hex chars");
if (!GCS_BUCKET) throw new Error("GCS_BUCKET is required");

const CONTEXT_PACK_KEY = Buffer.from(CONTEXT_PACK_KEY_HEX, "hex");

// ── File collection ────────────────────────────────────────────────────────

const EXCLUDED_PATTERNS = ["HEALTH", "FINANCE", "CONTACT"];

async function collectFiles(dir: string, recursive = false): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(PAI_DIR, full).toUpperCase();
      if (EXCLUDED_PATTERNS.some((p) => rel.includes(p))) continue;
      if (entry.isDirectory() && recursive) {
        paths.push(...(await collectFiles(full, true)));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        paths.push(full);
      }
    }
  } catch {
    // dir may not exist
  }
  return paths;
}

const FILES_TO_READ = [
  `${PAI_DIR}/USER/PRINCIPAL_IDENTITY.md`,
  `${PAI_DIR}/USER/DA_IDENTITY.md`,
  `${PAI_DIR}/USER/TELOS/MISSION.md`,
  `${PAI_DIR}/USER/TELOS/GOALS.md`,
  `${PAI_DIR}/USER/TELOS/BELIEFS.md`,
  `${PAI_DIR}/USER/TELOS/WISDOM.md`,
];

async function buildMemoryBlob(): Promise<string> {
  console.log("[sync] reading PAI memory...");
  const parts: string[] = [];

  for (const path of FILES_TO_READ) {
    try {
      const content = await readFile(path, "utf8");
      const label = relative(PAI_DIR, path);
      parts.push(`## ${label}\n${content}`);
    } catch {
      // file may not exist
    }
  }

  const knowledgeFiles = await collectFiles(`${PAI_DIR}/MEMORY/KNOWLEDGE`, true);
  for (const path of knowledgeFiles.slice(0, 50)) {
    try {
      const content = await readFile(path, "utf8");
      const label = relative(PAI_DIR, path);
      parts.push(`## ${label}\n${content}`);
    } catch {
      // skip
    }
  }

  let blob = parts.join("\n\n---\n\n");
  // Cap at 80,000 chars to stay within Claude context
  if (blob.length > 80_000) {
    blob = blob.slice(blob.length - 80_000);
  }
  console.log(`[sync] collected ${parts.length} files, ${blob.length} chars`);
  return blob;
}

// ── Distillation ───────────────────────────────────────────────────────────

async function distil(blob: string): Promise<string> {
  console.log("[sync] distilling via Claude...");
  const client = new Anthropic({ apiKey: CLAUDE_API_KEY });
  const now = new Date().toISOString();

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: "You are a context pack generator for a personal AI assistant. Extract structured facts from the provided PAI memory files and output only valid JSON.",
    messages: [
      {
        role: "user",
        content: `Generate a JSON context pack from these PAI memory files. Output ONLY valid JSON with no markdown fences or explanation.

Required schema:
{
  "version": "1.0",
  "generated": "${now}",
  "identity": { "name": string, "timezone": string, "communication_style": string },
  "active_goals": string[],
  "preferences": Record<string, string>,
  "recent_summary": string,
  "last_sync": "${now}"
}

Rules:
- active_goals: max 10 items, each max 100 chars
- preferences: max 20 key-value pairs
- recent_summary: max 2000 chars, 30-day rolling summary of key decisions and context
- Use the principal's name from PRINCIPAL_IDENTITY.md for identity.name
- Extract timezone from PRINCIPAL_IDENTITY.md or default to America/Los_Angeles

PAI Memory:
${blob}`,
      },
    ],
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected Claude response type");

  let jsonStr = block.text.trim();
  // Strip markdown code fences if present
  jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  return jsonStr;
}

// ── Encryption ─────────────────────────────────────────────────────────────

function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", CONTEXT_PACK_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: [12-byte IV][16-byte authTag][ciphertext]
  return Buffer.concat([iv, authTag, encrypted]);
}

// ── Upload ─────────────────────────────────────────────────────────────────

async function upload(encrypted: Buffer): Promise<void> {
  console.log("[sync] uploading to GCS...");
  const tmpPath = "/tmp/context-pack.json.enc";
  await Bun.write(tmpPath, encrypted);

  const proc = Bun.spawn(
    ["gcloud", "storage", "cp", tmpPath, `gs://${GCS_BUCKET}/context-pack.json.enc`],
    { stdout: "inherit", stderr: "inherit" }
  );
  await proc.exited;

  if (proc.exitCode !== 0) throw new Error("gcloud storage cp failed");

  // Clean up temp file
  try {
    await Bun.file(tmpPath).arrayBuffer(); // ensure written
  } catch {
    // ignore
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

const blob = await buildMemoryBlob();
const jsonStr = await distil(blob);

// Validate JSON before encrypting
let pack: Record<string, unknown>;
try {
  pack = JSON.parse(jsonStr);
} catch (err) {
  console.error("[sync] Claude returned invalid JSON:");
  console.error(jsonStr.slice(0, 500));
  process.exit(1);
}

const requiredFields = ["version", "generated", "identity", "active_goals", "preferences", "recent_summary", "last_sync"];
for (const field of requiredFields) {
  if (!(field in pack)) {
    console.error(`[sync] context pack missing required field: ${field}`);
    process.exit(1);
  }
}

console.log("[sync] encrypting...");
const encrypted = encrypt(jsonStr);
await upload(encrypted);

const ageMs = 0; // just generated
console.log(`[sync] done. Pack generated: ${pack.generated}, size: ${encrypted.length} bytes`);
