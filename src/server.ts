import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import type { AppSecrets, ContextPack, TelegramUpdate } from "./types.ts";
import { loadSecrets } from "./secrets.ts";
import { loadContextPack, loadConversationWindow, appendConversationEntry } from "./memory.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { askClaude } from "./claude.ts";
import { sendMessage } from "./telegram.ts";
import { handleMcpPost } from "./mcp.ts";

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

const pendingAuthCodes = new Map<string, { codeChallenge: string; redirectUri: string; expiresAt: number }>();

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

    if (url.pathname === "/mcp") {
      if (req.method === "POST") return handleMcpPost(req, secrets, () => contextPack);
      return new Response(JSON.stringify({ error: "use POST for MCP Streamable HTTP transport" }), {
        status: 405,
        headers: { "content-type": "application/json", "allow": "POST" },
      });
    }

    // ── OAuth 2.0 (for claude.ai web connector) ─────────────────────────────
    //
    // claude.ai uses authorization code flow + PKCE. Flow:
    //   1. GET /authorize  → validate client, generate code, redirect to claude.ai
    //   2. POST /oauth/token with code + code_verifier → return access_token
    //
    // The access_token IS the MCP bearer token — same auth path as Claude Code CLI.

    const OAUTH_HOST = "cloud-coco-747929980753.us-central1.run.app";
    const ALLOWED_REDIRECT_PREFIX = "https://claude.ai/";

    // In-memory authorization code store (10 min TTL, single-use)
    // Acceptable for single-user personal server — codes are short-lived and PKCE-protected.

    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: `https://${OAUTH_HOST}`,
        authorization_endpoint: `https://${OAUTH_HOST}/authorize`,
        token_endpoint: `https://${OAUTH_HOST}/oauth/token`,
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        response_types_supported: ["code"],
      });
    }

    if (req.method === "GET" && url.pathname === "/authorize") {
      const responseType = url.searchParams.get("response_type");
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
      const state = url.searchParams.get("state");

      if (responseType !== "code" || !clientId || !redirectUri || !codeChallenge) {
        return new Response("Missing required OAuth parameters", { status: 400 });
      }
      if (!redirectUri.startsWith(ALLOWED_REDIRECT_PREFIX)) {
        return new Response("redirect_uri not allowed", { status: 400 });
      }
      if (codeChallengeMethod !== "S256") {
        return new Response("Only S256 code_challenge_method supported", { status: 400 });
      }

      // Generate authorization code and store with PKCE challenge
      const code = randomUUID();
      pendingAuthCodes.set(code, {
        codeChallenge,
        redirectUri,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      if (state) redirect.searchParams.set("state", state);
      return Response.redirect(redirect.toString(), 302);
    }

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      if (!secrets.mcpBearerToken) return Response.json({ error: "server_error" }, { status: 500 });

      // Parse form body (claude.ai sends application/x-www-form-urlencoded)
      let params: Record<string, string> = {};
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.formData();
        for (const [k, v] of form.entries()) params[k] = v as string;
      } else {
        params = await req.json() as Record<string, string>;
      }

      const { grant_type, code, code_verifier, redirect_uri } = params;

      if (grant_type !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (!code || !code_verifier || !redirect_uri) {
        return Response.json({ error: "invalid_request" }, { status: 400 });
      }

      const stored = pendingAuthCodes.get(code);
      if (!stored || stored.expiresAt < Date.now()) {
        pendingAuthCodes.delete(code);
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      pendingAuthCodes.delete(code); // single-use

      if (stored.redirectUri !== redirect_uri) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      // Verify PKCE: SHA256(code_verifier) encoded as base64url must equal code_challenge
      const computed = createHash("sha256").update(code_verifier).digest("base64url");
      if (computed !== stored.codeChallenge) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }

      return Response.json({
        access_token: secrets.mcpBearerToken,
        token_type: "bearer",
        expires_in: 3600,
      });
    }

    return new Response(null, { status: 404 });
  },
});

console.log(`[server] listening on :${PORT}`);
