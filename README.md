# Cloud Coco

A cloud-resident personal assistant running on GCP Cloud Run. Cloud Coco is the always-on counterpart to a local [PAI](https://github.com/sverze/pai) instance — it carries your identity, goals, and preferences into the cloud and exposes them to every Claude surface you use: Telegram, Claude Code on MacBook, Claude Code on iPhone, and the claude.ai browser.

## Architecture

```
MacBook (PAI)                           GCP
──────────────────────────────          ────────────────────────────────────────
~/.claude/PAI/
  USER/                                 Secret Manager
  MEMORY/KNOWLEDGE/                       CLAUDE_API_KEY
       │                                  TELEGRAM_BOT_TOKEN
       │ bun sync                         CONTEXT_PACK_KEY
       ▼                                  ALLOWED_CHAT_IDS
  context-pack                            TELEGRAM_WEBHOOK_SECRET
  (encrypted)  ──────────────────────►    RELAY_URL
                                          RELAY_BEARER_TOKEN
  relay-server.ts (127.0.0.1:3001)        MCP_BEARER_TOKEN
       ▲               │
       │               │                GCS bucket (FUSE-mounted at /memory)
  Tailscale Funnel     │                  context-pack.json.enc (AES-256-GCM)
  (HTTPS tunnel)       │                  conversations/YYYY-MM-DD.jsonl
       ▲               │                  notes/YYYY-MM-DD.jsonl
       │               │                  decisions/YYYY-MM-DD.jsonl
       └───────────────┘                  learnings/YYYY-MM-DD.jsonl

                                        Cloud Run (Bun server)
Claude Code (MacBook) ──── MCP ────────►  POST /mcp  (Streamable HTTP)
Claude Code (iPhone)  ──── MCP ────────►  POST /mcp
claude.ai browser ── OAuth+MCP ────────►  GET  /authorize
                                          POST /oauth/token
                                          POST /mcp

Telegram ──── webhook ─────────────────►  POST /webhook
                                            ├── relay online → MacBook Claude
                                            └── relay offline → context-pack + web search
```

**Access surfaces:**

- **Telegram** — the original always-on chat interface. Relay path (MacBook Claude) when online; context-pack fallback when offline.
- **Claude Code (MCP)** — 12 tools available in any Claude Code session on MacBook or iPhone: memory search, note logging, goals, daily brief, decision/learning logging, conversation history, Telegram notifications, and more.
- **claude.ai browser (MCP)** — same 12 tools via OAuth 2.0 Authorization Code + PKCE connector.

**Context pack** — a distilled JSON snapshot of your PAI identity, goals, and preferences. Generated locally, AES-256-GCM encrypted, pushed to GCS. Loaded at Cloud Run startup and refreshed on `/sync`.

**Conversation log** — every Telegram exchange is appended to a daily JSONL file in GCS. Each request loads the last 20 entries as a sliding context window.

## Prerequisites

- GCP account with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) authenticated (`gcloud auth login`)
- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)
- [Docker](https://docs.docker.com/get-docker/) with BuildKit (for the container image)
- [Tailscale](https://tailscale.com) with Funnel enabled (for the relay path)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Your Telegram chat ID (send a message to [@userinfobot](https://t.me/userinfobot))
- An [Anthropic API key](https://console.anthropic.com/)

## Setup

### 1. Fill in bootstrap variables

Edit `scripts/bootstrap.sh` and fill in the four required values:

```bash
BILLING_ACCOUNT_ID=""   # gcloud billing accounts list
TELEGRAM_BOT_TOKEN=""   # from @BotFather
ALLOWED_CHAT_IDS=""     # your Telegram chat ID (comma-separated for multiple)
CLAUDE_API_KEY=""       # from console.anthropic.com
```

### 2. Run the bootstrap script

```bash
bash scripts/bootstrap.sh
```

This creates a GCP project, GCS bucket, service account, and stores secrets in Secret Manager. It writes `~/.env.cloud-coco` with the generated encryption key and bucket name.

### 3. Push your first context pack

```bash
bun install
bun sync
```

This reads your local PAI memory files, distils them into a context pack via Claude, encrypts it, and uploads to GCS.

```bash
# Optional — if PAI is not at the default location
PAI_DIR=/path/to/your/PAI bun sync
```

### 4. Set up the MacBook relay (recommended)

The relay lets Cloud Coco route Telegram messages to your local Claude Code instance when your MacBook is online.

**a. Generate a bearer token and configure Tailscale Funnel:**

```bash
openssl rand -hex 32

echo -n "YOUR_TOKEN" | gcloud secrets create RELAY_BEARER_TOKEN --data-file=- --project=YOUR_PROJECT_ID
echo -n "https://YOUR-MACHINE.tailbfcc6e.ts.net" | gcloud secrets create RELAY_URL --data-file=- --project=YOUR_PROJECT_ID
echo "RELAY_BEARER_TOKEN=YOUR_TOKEN" >> ~/.env.cloud-coco

tailscale funnel --bg localhost:3001
```

**b. Install the relay as a launchd service (auto-starts at login):**

```bash
cp ~/Library/LaunchAgents/com.cloud-coco.relay.plist ~/Library/LaunchAgents/com.cloud-coco.relay.plist
launchctl load ~/Library/LaunchAgents/com.cloud-coco.relay.plist

tail -f /tmp/cloud-coco-relay.log /tmp/cloud-coco-relay.error.log
```

The plist template is embedded at the bottom of `tools/relay-server.ts`. The relay binds to `127.0.0.1:3001` only — Tailscale Funnel is the sole external ingress.

### 5. Generate an MCP bearer token

The MCP server authenticates all Claude Code and claude.ai connections with a single bearer token:

```bash
openssl rand -hex 32

echo -n "YOUR_MCP_TOKEN" | gcloud secrets create MCP_BEARER_TOKEN --data-file=- --project=YOUR_PROJECT_ID
echo "MCP_BEARER_TOKEN=YOUR_MCP_TOKEN" >> ~/.env.cloud-coco

# Grant the Cloud Run SA access to the new secret
gcloud secrets add-iam-policy-binding MCP_BEARER_TOKEN \
  --member="serviceAccount:cloud-coco-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=YOUR_PROJECT_ID
```

Redeploy after adding the secret so the updated `--set-secrets` flag picks it up.

### 6. Build and push the container image

```bash
PROJECT_ID=$(gcloud config get project)
REGION=us-central1
IMAGE="gcr.io/${PROJECT_ID}/cloud-coco"

gcloud auth configure-docker gcr.io
docker build --platform linux/amd64 -t ${IMAGE}:latest .
docker push ${IMAGE}:latest
```

> **Apple Silicon note:** `--platform linux/amd64` is required — Cloud Run only accepts `amd64` images.

### 7. Deploy to Cloud Run

```bash
SA_EMAIL="cloud-coco-sa@${PROJECT_ID}.iam.gserviceaccount.com"
BUCKET_NAME=$(grep GCS_BUCKET ~/.env.cloud-coco | cut -d= -f2)

gcloud run deploy cloud-coco \
  --image=${IMAGE}:latest \
  --region=${REGION} \
  --service-account=${SA_EMAIL} \
  --execution-environment=gen2 \
  --add-volume=name=memory,type=cloud-storage,bucket=${BUCKET_NAME} \
  --add-volume-mount=volume=memory,mount-path=/memory \
  --set-secrets=CLAUDE_API_KEY=CLAUDE_API_KEY:latest,TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,CONTEXT_PACK_KEY=CONTEXT_PACK_KEY:latest,ALLOWED_CHAT_IDS=ALLOWED_CHAT_IDS:latest,TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,RELAY_URL=RELAY_URL:latest,RELAY_BEARER_TOKEN=RELAY_BEARER_TOKEN:latest,MCP_BEARER_TOKEN=MCP_BEARER_TOKEN:latest \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60s \
  --allow-unauthenticated
```

### 8. Register the Telegram webhook

```bash
SERVICE_URL=$(gcloud run services describe cloud-coco --region=${REGION} --format='value(status.url)')
WEBHOOK_SECRET=$(gcloud secrets versions access latest --secret=TELEGRAM_WEBHOOK_SECRET --project=${PROJECT_ID})

curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${SERVICE_URL}/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\"}"
```

Open Telegram, find your bot, and send `/start`.

### 9. Connect Claude Code (MacBook / iPhone)

```bash
MCP_TOKEN=$(grep MCP_BEARER_TOKEN ~/.env.cloud-coco | cut -d= -f2)
SERVICE_URL="https://YOUR-PROJECT.us-central1.run.app"

claude mcp add cloud-coco \
  --transport http \
  --scope user \
  --header "Authorization: Bearer ${MCP_TOKEN}" \
  "${SERVICE_URL}/mcp"
```

For iPhone: open **Claude Code** → Settings → MCP Servers → add server manually with the same URL and `Authorization: Bearer YOUR_TOKEN` header.

Verify the connection:

```bash
claude mcp list
# cloud-coco: https://... (connected)
```

### 10. Connect claude.ai browser

In [claude.ai](https://claude.ai) → Settings → Integrations → **Add custom connector**:

- **Remote MCP server URL:** `https://YOUR-PROJECT.us-central1.run.app/mcp`

Claude will redirect to `/authorize` to complete the OAuth flow. No client secret is required — the bearer token issued after PKCE verification is your `MCP_BEARER_TOKEN`.

## MCP tools

| Tool | Description |
|------|-------------|
| `search_memory` | Full-text search across conversations, notes, decisions, and learnings |
| `log_note` | Save a note with optional tags and topic to GCS |
| `get_context_pack` | Read the current context pack (identity, goals, preferences) |
| `get_goals` | Return active goals from the context pack |
| `get_daily_brief` | Today's exchange count, context pack age, relay state |
| `log_decision` | Record a titled decision with rationale and project |
| `log_learning` | Record an insight with optional project context |
| `get_recent_conversations` | Last N Telegram conversation entries |
| `get_recent_notes` | Last N logged notes |
| `get_recent_decisions` | Last N logged decisions |
| `get_recent_learnings` | Last N logged learnings |
| `send_notification` | Send a Telegram message to the default chat |

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction and command list |
| `/status` | Context pack age, relay state (online/offline), today's exchange count |
| `/sync` | Reload context pack from GCS (after running `bun sync` locally) |

Any other Telegram message is treated as a conversation. If the relay is online it routes to your MacBook Claude; otherwise it answers from the context pack with web search.

## Keeping context fresh

```bash
bun sync          # push updated context pack to GCS
# then in Telegram:
/sync             # reload from GCS into the running container
```

## Local development

```bash
export CLAUDE_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
export CONTEXT_PACK_KEY=...        # 64 hex chars
export ALLOWED_CHAT_IDS=...
export TELEGRAM_WEBHOOK_SECRET=... # any string locally
export MCP_BEARER_TOKEN=...        # any string locally
export RELAY_URL=...               # optional
export RELAY_BEARER_TOKEN=...      # optional

bun start
```

The server listens on port 8080. Use [ngrok](https://ngrok.com/) or Tailscale Funnel to expose it for Telegram webhook testing.

## Project structure

```
cloud-coco/
├── src/
│   ├── server.ts        # Bun HTTP server — webhook, relay routing, MCP, OAuth
│   ├── mcp.ts           # MCP Streamable HTTP handler (12 tools, GCS JSONL storage)
│   ├── secrets.ts       # GCP Secret Manager (Cloud Run) or env vars (local)
│   ├── memory.ts        # GCS context pack decrypt, conversation log read/write
│   ├── system-prompt.ts # Builds Claude system prompt from context pack
│   ├── claude.ts        # Anthropic SDK wrapper with web search
│   ├── telegram.ts      # Raw fetch Telegram client
│   └── types.ts         # Shared TypeScript interfaces
├── tools/
│   ├── relay-server.ts       # MacBook-side relay (Bun server, 127.0.0.1:3001)
│   └── sync-context-pack.ts  # Context pack push script (bun sync)
├── scripts/
│   └── bootstrap.sh     # One-time GCP project setup
├── Dockerfile
├── .env.example
└── tsconfig.json
```

## Security

- **Webhook secret** — every Telegram update is validated with `X-Telegram-Bot-Api-Secret-Token` before any processing. Invalid tokens get a silent 200.
- **MCP bearer token** — all MCP requests require `Authorization: Bearer TOKEN`. Compared with `timingSafeEqual` to prevent timing attacks.
- **OAuth PKCE** — the claude.ai connector uses Authorization Code + S256 PKCE. Authorization codes are single-use UUID tokens with a 10-minute TTL stored in memory. PKCE verifier is checked with `SHA256(verifier) == challenge` before issuing the bearer token.
- **Relay bearer token** — Cloud Run presents a bearer token to the relay. Relay rejects any token under 16 characters at startup.
- **Relay bind** — the relay binds to `127.0.0.1` only. Tailscale Funnel is the sole external ingress.
- **Prompt injection hardening** — user text is passed to `claude` via stdin wrapped in sentinels. Messages containing those sentinel strings are rejected.
- **Scrubbed child env** — the relay's `claude` subprocess only inherits `PATH`, `HOME`, and `USER`. No API keys or credentials can leak.
- **No shell interpolation** — `Bun.spawn` uses an explicit argv array; user text never appears on a command line.
- **GCS encryption** — context pack is AES-256-GCM encrypted at rest. Key lives only in Secret Manager and `~/.env.cloud-coco`.
- **Allowlist** — `ALLOWED_CHAT_IDS` is checked before any Telegram API call; unknown chat IDs receive no response.
- Never commit `~/.env.cloud-coco` or any file containing actual credentials.
