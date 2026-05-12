/**
 * harvest.ts — GCS → local PAI memory pull
 *
 * Reads new notes, decisions, and learnings from GCS (written by Cloud Coco
 * MCP tools from any Claude surface) and writes them into the local PAI
 * MEMORY/LEARNING/CLOUDCOCO directory as markdown files.
 *
 * Local PAI is authoritative. GCS is the cross-device write point. This
 * script closes the loop so activity on iPhone, claude.ai, or Telegram
 * feeds back into the MacBook memory that bun sync distils.
 *
 * State: ~/.cloud-coco-harvest-state.json tracks last_harvested timestamp.
 *
 * Required env (or ~/.env.cloud-coco):
 *   GCS_BUCKET — bucket name, e.g. cloud-coco-memory-abc123
 *   PAI_DIR    — optional, defaults to ~/.claude/PAI
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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
    // no file
  }
}

await loadEnvFile();

const GCS_BUCKET = process.env.GCS_BUCKET;
const PAI_DIR = process.env.PAI_DIR ?? `${process.env.HOME}/.claude/PAI`;

if (!GCS_BUCKET) throw new Error("GCS_BUCKET is required");

// ── State ──────────────────────────────────────────────────────────────────

interface HarvestState {
  last_harvested: string; // ISO 8601 timestamp — entries with ts <= this are skipped
  total_harvested: number;
}

const STATE_PATH = `${process.env.HOME}/.cloud-coco-harvest-state.json`;

async function loadState(): Promise<HarvestState> {
  try {
    const content = await readFile(STATE_PATH, "utf8");
    return JSON.parse(content) as HarvestState;
  } catch {
    // First run — harvest everything
    return { last_harvested: new Date(0).toISOString(), total_harvested: 0 };
  }
}

async function saveState(state: HarvestState): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ── GCS helpers ────────────────────────────────────────────────────────────

async function gcsLs(prefix: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["gcloud", "storage", "ls", `gs://${GCS_BUCKET}/${prefix}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".jsonl"));
}

async function gcsCat(gcsPath: string): Promise<string> {
  const proc = Bun.spawn(
    ["gcloud", "storage", "cat", gcsPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return out;
}

// ── PAI markdown generation ────────────────────────────────────────────────

// Filename: YYYY-MM-DD-HHMMSS_TYPE_slug.md
function toFilename(ts: string, type: string, slug: string): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/-$/, "");
  return `${date}-${time}_${type}_${safe}.md`;
}

// Directory: PAI_DIR/MEMORY/LEARNING/CLOUDCOCO/YYYY-MM/
function toDir(ts: string): string {
  const d = new Date(ts);
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return join(PAI_DIR, "MEMORY", "LEARNING", "CLOUDCOCO", month);
}

function fmtTimestamp(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} PST`;
}

function yamlList(items: string[]): string {
  if (!items || items.length === 0) return "[]";
  return `[${items.map((i) => `"${i.replace(/"/g, '\\"')}"`).join(", ")}]`;
}

interface GcsEntry {
  ts: string;
  source?: string;
  week?: string;
  quarter?: string;
  goals_snapshot?: string[];
  context_pack_ref?: string;
  // note fields
  content?: string;
  topic?: string;
  tags?: string[];
  // decision fields
  title?: string;
  rationale?: string;
  context?: string;
  project?: string;
  // learning fields
  insight?: string;
  source_note?: string;
}

function noteToMarkdown(e: GcsEntry): string {
  const tags = [...new Set([...(e.tags ?? []), "cloud-coco", "note", ...(e.topic ? [e.topic] : [])])];
  const frontmatter = [
    `capture_type: NOTE`,
    `timestamp: ${fmtTimestamp(e.ts)}`,
    `source: cloud-coco`,
    `auto_captured: true`,
    `tags: ${yamlList(tags)}`,
    ...(e.week ? [`week: ${e.week}`] : []),
    ...(e.quarter ? [`quarter: ${e.quarter}`] : []),
    ...(e.goals_snapshot?.length ? [`goals_snapshot: ${yamlList(e.goals_snapshot)}`] : []),
    ...(e.context_pack_ref ? [`context_pack_ref: "${e.context_pack_ref}"`] : []),
  ].join("\n");

  const heading = e.topic ? `# Note — ${e.topic}` : "# Note";

  return `---\n${frontmatter}\n---\n\n${heading}\n\n${e.content ?? ""}\n`;
}

function decisionToMarkdown(e: GcsEntry): string {
  const tags = ["cloud-coco", "decision", ...(e.project ? [e.project] : [])];
  const frontmatter = [
    `capture_type: DECISION`,
    `timestamp: ${fmtTimestamp(e.ts)}`,
    `source: cloud-coco`,
    `auto_captured: true`,
    `tags: ${yamlList(tags)}`,
    ...(e.project ? [`project: "${e.project}"`] : []),
    ...(e.week ? [`week: ${e.week}`] : []),
    ...(e.quarter ? [`quarter: ${e.quarter}`] : []),
    ...(e.goals_snapshot?.length ? [`goals_snapshot: ${yamlList(e.goals_snapshot)}`] : []),
    ...(e.context_pack_ref ? [`context_pack_ref: "${e.context_pack_ref}"`] : []),
  ].join("\n");

  const lines = [
    `---\n${frontmatter}\n---`,
    ``,
    `# Decision: ${e.title ?? "Untitled"}`,
    ``,
    `**Rationale:** ${e.rationale ?? ""}`,
  ];
  if (e.context) lines.push(``, `**Context:** ${e.context}`);

  return lines.join("\n") + "\n";
}

function learningToMarkdown(e: GcsEntry): string {
  const tags = ["cloud-coco", "learning", ...(e.project ? [e.project] : [])];
  const frontmatter = [
    `capture_type: LEARNING`,
    `timestamp: ${fmtTimestamp(e.ts)}`,
    `source: cloud-coco`,
    `auto_captured: true`,
    `tags: ${yamlList(tags)}`,
    ...(e.project ? [`project: "${e.project}"`] : []),
    ...(e.week ? [`week: ${e.week}`] : []),
    ...(e.quarter ? [`quarter: ${e.quarter}`] : []),
    ...(e.goals_snapshot?.length ? [`goals_snapshot: ${yamlList(e.goals_snapshot)}`] : []),
    ...(e.context_pack_ref ? [`context_pack_ref: "${e.context_pack_ref}"`] : []),
    ...(e.source_note ? [`source_note: "${e.source_note}"`] : []),
  ].join("\n");

  return `---\n${frontmatter}\n---\n\n# Learning\n\n${e.insight ?? ""}\n`;
}

// ── Harvest one GCS directory ──────────────────────────────────────────────

interface SourceConfig {
  subdir: string;
  type: "NOTE" | "DECISION" | "LEARNING";
  toMarkdown: (e: GcsEntry) => string;
  slug: (e: GcsEntry) => string;
}

const SOURCES: SourceConfig[] = [
  {
    subdir: "notes",
    type: "NOTE",
    toMarkdown: noteToMarkdown,
    slug: (e) => e.topic ?? "cloud-coco",
  },
  {
    subdir: "decisions",
    type: "DECISION",
    toMarkdown: decisionToMarkdown,
    slug: (e) => e.title ?? "decision",
  },
  {
    subdir: "learnings",
    type: "LEARNING",
    toMarkdown: learningToMarkdown,
    slug: (_e) => "cloud-coco",
  },
];

async function harvestSource(src: SourceConfig, since: string): Promise<{ count: number; latestTs: string }> {
  const gcsFiles = await gcsLs(`${src.subdir}/`);
  let count = 0;
  let latestTs = since;

  for (const gcsPath of gcsFiles) {
    // Parse date from filename (gs://bucket/notes/YYYY-MM-DD.jsonl)
    const filename = gcsPath.split("/").pop() ?? "";
    const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!dateMatch) continue;

    // Skip files entirely before the since date (by filename date only, as quick filter)
    if (dateMatch[1] < since.slice(0, 10)) continue;

    let text: string;
    try {
      text = await gcsCat(gcsPath);
    } catch {
      console.warn(`[harvest] could not read ${gcsPath}, skipping`);
      continue;
    }

    const entries = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l) as GcsEntry; } catch { return null; }
      })
      .filter((e): e is GcsEntry => e !== null && typeof e.ts === "string");

    for (const entry of entries) {
      // Skip entries already harvested
      if (entry.ts <= since) continue;

      const dir = toDir(entry.ts);
      await mkdir(dir, { recursive: true });

      const filename = toFilename(entry.ts, src.type, src.slug(entry));
      const markdown = src.toMarkdown(entry);
      await writeFile(join(dir, filename), markdown, "utf8");

      if (entry.ts > latestTs) latestTs = entry.ts;
      count++;
    }
  }

  return { count, latestTs };
}

// ── Main ───────────────────────────────────────────────────────────────────

const state = await loadState();
console.log(`[harvest] last harvested: ${state.last_harvested}`);

let latestTs = state.last_harvested;
let totalNew = 0;

for (const src of SOURCES) {
  const { count, latestTs: srcLatest } = await harvestSource(src, state.last_harvested);
  if (count > 0) console.log(`[harvest] ${src.subdir}: ${count} new entries`);
  if (srcLatest > latestTs) latestTs = srcLatest;
  totalNew += count;
}

if (totalNew === 0) {
  console.log("[harvest] nothing new");
} else {
  console.log(`[harvest] done — ${totalNew} entries written to ${PAI_DIR}/MEMORY/LEARNING/CLOUDCOCO/`);
}

await saveState({
  last_harvested: latestTs,
  total_harvested: state.total_harvested + totalNew,
});
