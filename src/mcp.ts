/**
 * mcp.ts — Cloud Coco MCP server (Streamable HTTP transport)
 *
 * Exposes Cloud Coco as a remote MCP server so Claude Code on any device
 * (MacBook, iPhone, browser) can access persistent memory, context, and
 * Telegram notifications as native tools.
 *
 * Transport: Streamable HTTP (MCP spec 2025-03-26)
 *   POST /mcp — stateless JSON-RPC 2.0 endpoint, responds with JSON
 *
 * No sessions, no SSE streams — each request is fully self-contained.
 * This works naturally with Cloud Run's stateless request model.
 *
 * Auth: Bearer token (MCP_BEARER_TOKEN secret), timing-safe compare.
 *
 * GCS layout (all under /memory FUSE mount):
 *   conversations/YYYY-MM-DD.jsonl  — Telegram exchanges
 *   notes/YYYY-MM-DD.jsonl          — logged from Claude Code
 *   decisions/YYYY-MM-DD.jsonl      — architectural decisions
 *   learnings/YYYY-MM-DD.jsonl      — captured learnings
 */

import { timingSafeEqual } from "node:crypto";
import { readdir, readFile, appendFile, mkdir } from "node:fs/promises";
import type { AppSecrets, ContextPack } from "./types.ts";
import { sendMessage } from "./telegram.ts";

// ── Protocol types ────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

// ── Auth ──────────────────────────────────────────────────────────────────

function checkBearer(req: Request, expected: string): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const presented = header.slice(7).trim();
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// ── GCS JSONL helpers ─────────────────────────────────────────────────────

const MEMORY_ROOT = "/memory";

function todayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

async function appendEntry(subdir: string, entry: Record<string, unknown>): Promise<void> {
  const dir = `${MEMORY_ROOT}/${subdir}`;
  await mkdir(dir, { recursive: true });
  await appendFile(`${dir}/${todayStr()}.jsonl`, JSON.stringify(entry) + "\n", "utf8");
}

async function readRecent(subdir: string, limit: number): Promise<Record<string, unknown>[]> {
  const dir = `${MEMORY_ROOT}/${subdir}`;
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const results: Record<string, unknown>[] = [];
  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const text = await readFile(`${dir}/${file}`, "utf8");
      const entries = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
      results.push(...entries.reverse().slice(0, limit - results.length));
    } catch { /* skip unreadable */ }
  }
  return results.slice(0, limit);
}

async function searchDir(subdir: string, query: string, limit: number): Promise<Record<string, unknown>[]> {
  const dir = `${MEMORY_ROOT}/${subdir}`;
  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const results: Record<string, unknown>[] = [];
  const q = query.toLowerCase();
  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const text = await readFile(`${dir}/${file}`, "utf8");
      const entries = text.split("\n").filter(l => l.trim()).map(l => JSON.parse(l) as Record<string, unknown>);
      for (const entry of entries.reverse()) {
        if (results.length >= limit) break;
        if (JSON.stringify(entry).toLowerCase().includes(q)) results.push(entry);
      }
    } catch { /* skip */ }
  }
  return results;
}

// ── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "search_memory",
    description: "Search across conversation history, notes, decisions, and learnings in Cloud Coco persistent memory. Use this to recall past discussions, decisions, or anything logged from a Claude Code session.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (case-insensitive text match)" },
        sources: {
          type: "array",
          items: { type: "string", enum: ["conversations", "notes", "decisions", "learnings"] },
          description: "Which sources to search. Defaults to all four.",
        },
        limit: { type: "number", description: "Max results per source (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "log_note",
    description: "Persist a note to Cloud Coco memory. Notes survive Claude Code session resets. Use for anything you want to recall later: blockers, context, observations, in-progress thoughts.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Note content" },
        topic: { type: "string", description: "Optional topic label (e.g. 'cloud-coco', 'auth-refactor')" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      required: ["content"],
    },
  },
  {
    name: "get_recent_notes",
    description: "Retrieve recent notes logged from Claude Code sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent notes (default 20)" },
      },
    },
  },
  {
    name: "get_context_pack",
    description: "Get the full PAI context pack: identity, active goals, preferences, and a 30-day summary. Use this to understand who you're assisting and what matters to them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_goals",
    description: "Get the active goals from the PAI context pack.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_daily_brief",
    description: "Get an orientation brief for starting a work session: active goals, recent summary, latest notes and decisions. Call this at the start of a session to get up to speed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "log_decision",
    description: "Record an architectural or design decision with rationale. Stored permanently in Cloud Coco memory and searchable. Use for any non-obvious choice worth explaining later.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short decision title" },
        rationale: { type: "string", description: "Why this decision was made" },
        context: { type: "string", description: "Optional: problem it solves, alternatives considered" },
        project: { type: "string", description: "Optional: project name" },
      },
      required: ["title", "rationale"],
    },
  },
  {
    name: "log_learning",
    description: "Capture a learning or insight worth feeding back into PAI context. Gets picked up on next bun sync and incorporated into future context packs.",
    inputSchema: {
      type: "object",
      properties: {
        insight: { type: "string", description: "The learning or insight" },
        source_note: { type: "string", description: "Optional: where this came from (e.g. debugging, reading, conversation)" },
        project: { type: "string", description: "Optional: related project" },
      },
      required: ["insight"],
    },
  },
  {
    name: "get_recent_decisions",
    description: "Retrieve recent architectural decisions logged from Claude Code sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent decisions (default 20)" },
        project: { type: "string", description: "Optional: filter by project name" },
      },
    },
  },
  {
    name: "get_recent_learnings",
    description: "Retrieve recent learnings captured from Claude Code sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent learnings (default 20)" },
      },
    },
  },
  {
    name: "get_recent_conversations",
    description: "Retrieve recent Telegram conversation history with Cloud Coco.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of exchanges (default 20)" },
      },
    },
  },
  {
    name: "send_telegram_message",
    description: "Send yourself a Telegram message from any Claude Code session. Use for async notifications ('finished the refactor'), reminders, or shipping a result you want to review on your phone.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text to send" },
      },
      required: ["text"],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  secrets: AppSecrets,
  getContextPack: () => ContextPack,
): Promise<string> {
  const now = new Date().toISOString();

  switch (name) {
    case "search_memory": {
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 10;
      const sources = (args.sources as string[] | undefined) ?? ["conversations", "notes", "decisions", "learnings"];
      const results: Record<string, Record<string, unknown>[]> = {};
      await Promise.all(
        sources.map(async (src) => {
          results[src] = await searchDir(src, query, limit);
        }),
      );
      const total = Object.values(results).reduce((n, r) => n + r.length, 0);
      if (total === 0) return `No results found for "${query}" across ${sources.join(", ")}.`;
      const lines: string[] = [`Search results for "${query}":\n`];
      for (const [src, entries] of Object.entries(results)) {
        if (entries.length === 0) continue;
        lines.push(`## ${src} (${entries.length})`);
        for (const e of entries) lines.push(JSON.stringify(e));
      }
      return lines.join("\n");
    }

    case "log_note": {
      const entry = {
        ts: now,
        content: args.content as string,
        ...(args.topic ? { topic: args.topic as string } : {}),
        ...(args.tags ? { tags: args.tags as string[] } : {}),
        source: "claude-code" as const,
      };
      await appendEntry("notes", entry);
      return `Note logged at ${now}.`;
    }

    case "get_recent_notes": {
      const limit = (args.limit as number | undefined) ?? 20;
      const entries = await readRecent("notes", limit);
      if (entries.length === 0) return "No notes found.";
      return entries.map(e => JSON.stringify(e)).join("\n");
    }

    case "get_context_pack": {
      const pack = getContextPack();
      return JSON.stringify(pack, null, 2);
    }

    case "get_goals": {
      const pack = getContextPack();
      if (pack.active_goals.length === 0) return "No active goals recorded. Run bun sync to refresh.";
      return `Active goals:\n${pack.active_goals.map(g => `- ${g}`).join("\n")}`;
    }

    case "get_daily_brief": {
      const pack = getContextPack();
      const ageH = Math.floor((Date.now() - new Date(pack.generated).getTime()) / 3_600_000);
      const recentNotes = await readRecent("notes", 5);
      const recentDecisions = await readRecent("decisions", 3);

      const goals = pack.active_goals.length > 0
        ? pack.active_goals.map(g => `- ${g}`).join("\n")
        : "- None recorded";

      const notesText = recentNotes.length > 0
        ? recentNotes.map(e => `- [${(e.ts as string).slice(0, 10)}] ${(e as Record<string, string>).content?.slice(0, 120)}`).join("\n")
        : "- None";

      const decisionsText = recentDecisions.length > 0
        ? recentDecisions.map(e => `- [${(e.ts as string).slice(0, 10)}] ${(e as Record<string, string>).title}: ${(e as Record<string, string>).rationale?.slice(0, 100)}`).join("\n")
        : "- None";

      return [
        `# Daily Brief — ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" }).format(new Date())}`,
        "",
        `## Active Goals`,
        goals,
        "",
        `## 30-Day Summary`,
        pack.recent_summary,
        "",
        `## Recent Notes`,
        notesText,
        "",
        `## Recent Decisions`,
        decisionsText,
        "",
        `Context pack age: ${ageH}h${ageH >= 72 ? " ⚠️ stale — run bun sync" : ""}`,
      ].join("\n");
    }

    case "log_decision": {
      const entry = {
        ts: now,
        title: args.title as string,
        rationale: args.rationale as string,
        ...(args.context ? { context: args.context as string } : {}),
        ...(args.project ? { project: args.project as string } : {}),
        source: "claude-code" as const,
      };
      await appendEntry("decisions", entry);
      return `Decision "${args.title}" logged at ${now}.`;
    }

    case "log_learning": {
      const entry = {
        ts: now,
        insight: args.insight as string,
        ...(args.source_note ? { source_note: args.source_note as string } : {}),
        ...(args.project ? { project: args.project as string } : {}),
        source: "claude-code" as const,
      };
      await appendEntry("learnings", entry);
      return `Learning logged at ${now}.`;
    }

    case "get_recent_decisions": {
      const limit = (args.limit as number | undefined) ?? 20;
      let entries = await readRecent("decisions", limit * 2);
      if (args.project) {
        const proj = (args.project as string).toLowerCase();
        entries = entries.filter(e => ((e.project as string | undefined) ?? "").toLowerCase().includes(proj));
      }
      entries = entries.slice(0, limit);
      if (entries.length === 0) return "No decisions found.";
      return entries.map(e => JSON.stringify(e)).join("\n");
    }

    case "get_recent_learnings": {
      const limit = (args.limit as number | undefined) ?? 20;
      const entries = await readRecent("learnings", limit);
      if (entries.length === 0) return "No learnings found.";
      return entries.map(e => JSON.stringify(e)).join("\n");
    }

    case "get_recent_conversations": {
      const limit = (args.limit as number | undefined) ?? 20;
      const entries = await readRecent("conversations", limit);
      if (entries.length === 0) return "No conversations found.";
      return entries
        .map(e => `[${(e.ts as string).slice(0, 16)}] ${e.role}: ${(e.content as string).slice(0, 200)}`)
        .join("\n");
    }

    case "send_telegram_message": {
      const text = args.text as string;
      const chatIds = Array.from(secrets.allowedChatIds);
      if (chatIds.length === 0) return "No allowed chat IDs configured.";
      await Promise.all(chatIds.map(id => sendMessage(id, text, secrets.telegramToken)));
      return `Message sent to ${chatIds.length} chat${chatIds.length !== 1 ? "s" : ""}.`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC dispatch ─────────────────────────────────────────────────────

async function dispatch(
  msg: JsonRpcRequest,
  secrets: AppSecrets,
  getContextPack: () => ContextPack,
): Promise<JsonRpcResponse | null> {
  const id = ("id" in msg ? msg.id : undefined) ?? null;
  const isNotification = !("id" in msg);

  try {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "cloud-coco", version: "2.0.0" },
          },
        };

      case "initialized":
      case "notifications/initialized":
        return null; // notification — no response

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: toolArgs = {} } = msg.params as { name: string; arguments?: Record<string, unknown> };
        const text = await executeTool(name, toolArgs, secrets, getContextPack);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        };
      }

      default:
        if (isNotification) return null;
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        };
    }
  } catch (err) {
    console.error(`[mcp] tool error: ${(err as Error).message}`);
    if (isNotification) return null;
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: (err as Error).message },
    };
  }
}

// ── HTTP handler (stateless Streamable HTTP transport) ────────────────────

export async function handleMcpPost(
  req: Request,
  secrets: AppSecrets,
  getContextPack: () => ContextPack,
): Promise<Response> {
  if (!secrets.mcpBearerToken || !checkBearer(req, secrets.mcpBearerToken)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const messages: JsonRpcRequest[] = Array.isArray(body) ? body : [body as JsonRpcRequest];
  const responses: JsonRpcResponse[] = [];

  for (const msg of messages) {
    const response = await dispatch(msg, secrets, getContextPack);
    if (response !== null) responses.push(response);
  }

  if (responses.length === 0) return new Response(null, { status: 202 });

  const body_out = responses.length === 1 ? responses[0] : responses;
  return new Response(JSON.stringify(body_out), {
    headers: { "content-type": "application/json" },
  });
}
