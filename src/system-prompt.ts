import type { ContextPack, ConversationEntry } from "./types.ts";

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

function freshnessWarning(pack: ContextPack): string {
  const ageMs = Date.now() - new Date(pack.generated).getTime();
  if (ageMs <= SEVENTY_TWO_HOURS_MS) return "";
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return `⚠️ Context pack last synced ${days} day${days !== 1 ? "s" : ""} ago. Facts may be stale. Run /sync for fresh context.\n\n`;
}

function formatDateTime(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date());
}

function formatWindow(window: ConversationEntry[]): string {
  if (window.length === 0) return "";
  const lines = window.map((e) =>
    e.role === "user" ? `User: ${e.content}` : `Coco: ${e.content}`
  );
  return `## Recent Conversation\n${lines.join("\n")}\n\n`;
}

export function buildSystemPrompt(pack: ContextPack, window: ConversationEntry[]): string {
  const goals =
    pack.active_goals.length > 0
      ? pack.active_goals.map((g) => `- ${g}`).join("\n")
      : "- None recorded";

  const prefs =
    Object.keys(pack.preferences).length > 0
      ? Object.entries(pack.preferences).map(([k, v]) => `- ${k}: ${v}`).join("\n")
      : "- None recorded";

  return `You are Coco, sverze's personal AI assistant running in cloud mode. You are direct, curious, and opinionated when evidence warrants. First person always. You are a peer, not a tool.

You are running as Cloud Coco — a distilled, always-on version of the full local PAI assistant. You have access to a context pack distilled from PAI memory, but not the full local assistant. Be honest about what you know and don't know.

${freshnessWarning(pack)}## Identity
Name: ${pack.identity.name}
Timezone: ${pack.identity.timezone}
Communication style: ${pack.identity.communication_style}

## Active Goals
${goals}

## Preferences
${prefs}

## Recent Context (30-day summary)
${pack.recent_summary}

Context pack generated: ${pack.generated}

## Current Date/Time
${formatDateTime()}

${formatWindow(window)}Respond conversationally. Keep responses concise (1-4 paragraphs unless detail is needed). You are on Telegram — no markdown headers, minimal bullet points.`;
}
