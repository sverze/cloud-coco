import type { AppSecrets, ContextPack, TelegramUpdate } from "./types.ts";
import { loadSecrets } from "./secrets.ts";
import { loadContextPack, loadConversationWindow, appendConversationEntry } from "./memory.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { askClaude } from "./claude.ts";
import { sendMessage } from "./telegram.ts";

const PORT = Number(process.env.PORT) || 8080;

let secrets: AppSecrets;
let contextPack: ContextPack;

// ── Startup ────────────────────────────────────────────────────────────────

secrets = await loadSecrets();
contextPack = await loadContextPack(secrets.contextPackKey);

const ageH = Math.floor((Date.now() - new Date(contextPack.generated).getTime()) / 3_600_000);
console.log(`[server] startup complete — context pack age: ${ageH}h`);

// ── Command handlers ───────────────────────────────────────────────────────

function handleStart(): string {
  return `Hi! I'm Coco — your always-on assistant running in the cloud.

Commands:
/status — context pack age and sync info
/sync — reload context pack from GCS
/memory [query] — deep memory search (Phase 2, coming soon)

Or just chat — I'll respond using your PAI context.`;
}

async function handleSync(): Promise<string> {
  contextPack = await loadContextPack(secrets.contextPackKey);
  const newAgeH = Math.floor((Date.now() - new Date(contextPack.generated).getTime()) / 3_600_000);
  return `Context pack reloaded.\nGenerated: ${contextPack.generated}\nLast sync: ${contextPack.last_sync}\nAge: ${newAgeH}h`;
}

async function handleStatus(): Promise<string> {
  const window = await loadConversationWindow();
  const todayCount = window.filter((e) => {
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    return e.ts.startsWith(d.slice(0, 10));
  }).length;
  const ageH = Math.floor((Date.now() - new Date(contextPack.generated).getTime()) / 3_600_000);
  const staleWarning = ageH >= 72 ? `\n⚠️ Context is ${Math.floor(ageH / 24)} days old — run /sync` : "";
  return `Context pack: ${contextPack.generated}\nLast sync: ${contextPack.last_sync}\nAge: ${ageH}h\nToday's exchanges: ${todayCount}${staleWarning}`;
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const window = await loadConversationWindow();
  const systemPrompt = buildSystemPrompt(contextPack, window);
  const reply = await askClaude(systemPrompt, text, secrets.claudeApiKey);

  const now = new Date().toISOString();
  await Promise.all([
    appendConversationEntry({ ts: now, role: "user", content: text }),
    appendConversationEntry({ ts: new Date(Date.now() + 1).toISOString(), role: "assistant", content: reply }),
  ]);

  await sendMessage(chatId, reply, secrets.telegramToken);
}

// ── Request handler ────────────────────────────────────────────────────────

async function handleWebhook(req: Request): Promise<Response> {
  // ISC-1/2: validate webhook secret before any processing
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (incomingSecret !== secrets.webhookSecret) return new Response(null, { status: 200 });

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response(null, { status: 200 });
  }

  const message = update.message;
  if (!message?.text) return new Response(null, { status: 200 });

  // ISC-6: drop bot messages
  if (message.from.is_bot) return new Response(null, { status: 200 });

  const chatId = message.chat.id;

  // ISC-4 / ISC-5: allowlist check BEFORE any API calls
  if (!secrets.allowedChatIds.has(chatId)) return new Response(null, { status: 200 });

  const text = message.text.trim();

  try {
    let reply: string | undefined;

    if (text === "/start") {
      reply = handleStart();
    } else if (text === "/sync") {
      reply = await handleSync();
    } else if (text === "/status") {
      reply = await handleStatus();
    } else if (text.startsWith("/memory")) {
      reply = "Deep memory search is coming in Phase 2. For now, ask me directly and I'll use what I know.";
    } else {
      await handleMessage(chatId, text);
      return new Response(null, { status: 200 });
    }

    if (reply) await sendMessage(chatId, reply, secrets.telegramToken);
  } catch (err) {
    console.error(`[server] handler error: ${(err as Error).message}`);
    await sendMessage(chatId, "Something went wrong on my end. Try again in a moment.", secrets.telegramToken);
  }

  return new Response(null, { status: 200 });
}

// ── Server ─────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(req);
    }

    return new Response(null, { status: 404 });
  },
});

console.log(`[server] listening on :${PORT}`);
