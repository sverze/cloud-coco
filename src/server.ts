import type { AppSecrets, ContextPack, TelegramUpdate } from "./types.ts";
import { loadSecrets } from "./secrets.ts";
import { loadContextPack, loadConversationWindow, appendConversationEntry } from "./memory.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { askClaude } from "./claude.ts";
import { sendMessage } from "./telegram.ts";
import { handleMcpConnect, handleMcpMessage } from "./mcp.ts";

const PORT = Number(process.env.PORT) || 8080;

let secrets: AppSecrets;
let contextPack: ContextPack;

// ── Startup ────────────────────────────────────────────────────────────────

secrets = await loadSecrets();
contextPack = await loadContextPack(secrets.contextPackKey);

const ageH = Math.floor((Date.now() - new Date(contextPack.generated).getTime()) / 3_600_000);
console.log(`[server] startup complete — context pack age: ${ageH}h`);

// ── Relay client ───────────────────────────────────────────────────────────

const RELAY_HEALTH_TIMEOUT_MS = 5_000;
const RELAY_MESSAGE_TIMEOUT_MS = 57_000;

async function relayIsReachable(relayUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${relayUrl}/health`, {
      signal: AbortSignal.timeout(RELAY_HEALTH_TIMEOUT_MS),
    });
    console.log(`[relay-health] ${res.ok ? "ok" : `http ${res.status}`}`);
    return res.ok;
  } catch (err) {
    console.log(`[relay-health] unreachable: ${(err as Error).message}`);
    return false;
  }
}

async function askRelay(relayUrl: string, bearerToken: string, text: string): Promise<string | null> {
  try {
    const res = await fetch(`${relayUrl}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(RELAY_MESSAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[relay-client] relay returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { reply?: string };
    return data.reply ?? null;
  } catch (err) {
    console.error(`[relay-client] error: ${(err as Error).message}`);
    return null;
  }
}

// ── Command handlers ───────────────────────────────────────────────────────

function handleStart(): string {
  return `Hi! I'm Coco — your always-on assistant running in the cloud.

Commands:
/status — context pack age, relay state, and sync info
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

  let relayState: string;
  if (!secrets.relayUrl) {
    relayState = "not configured";
  } else {
    relayState = (await relayIsReachable(secrets.relayUrl)) ? "online" : "offline";
  }

  return `Context pack: ${contextPack.generated}\nLast sync: ${contextPack.last_sync}\nAge: ${ageH}h\nToday's exchanges: ${todayCount}\nRelay: ${relayState}${staleWarning}`;
}

async function handleMessage(chatId: number, text: string): Promise<void> {
  const window = await loadConversationWindow();
  let reply: string;

  // ISC-20/21: try relay first if configured and reachable
  if (secrets.relayUrl && secrets.relayBearerToken && await relayIsReachable(secrets.relayUrl)) {
    console.log("[server] routing to MacBook relay");
    const relayReply = await askRelay(secrets.relayUrl, secrets.relayBearerToken, text);
    if (relayReply) {
      reply = relayReply;
    } else {
      console.log("[server] relay failed — falling back to context-pack path");
      const systemPrompt = buildSystemPrompt(contextPack, window);
      reply = await askClaude(systemPrompt, text, secrets.claudeApiKey);
    }
  } else {
    const systemPrompt = buildSystemPrompt(contextPack, window);
    reply = await askClaude(systemPrompt, text, secrets.claudeApiKey);
  }

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

    if (req.method === "GET" && url.pathname === "/mcp") {
      return handleMcpConnect(req, secrets, () => contextPack);
    }

    if (req.method === "POST" && url.pathname === "/mcp/message") {
      return handleMcpMessage(req, secrets, () => contextPack);
    }

    return new Response(null, { status: 404 });
  },
});

console.log(`[server] listening on :${PORT}`);
