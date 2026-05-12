# Cloud Coco

A cloud-resident personal assistant running as a Telegram bot on GCP Cloud Run. Cloud Coco is the always-on counterpart to a local [PAI](https://github.com/sverze/pai) instance — it carries your identity, goals, and preferences into the cloud so you can query your assistant from anywhere, even when your MacBook is closed.

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
  relay-server.ts (127.0.0.1:3001)
       ▲               │                GCS bucket
       │               │                  context-pack.json.enc (AES-256-GCM)
  Tailscale Funnel     │                  conversations/YYYY-MM-DD.jsonl
  (HTTPS tunnel)       │
       ▲               │                Cloud Run (Bun server)
       │               └──────────────►   │  route-or-fallback
       │                                  │  ├── relay online → MacBook Claude
       └──────────────────────────────────┘  └── relay offline → context-pack + web search
                                          │
                                    Telegram bot (webhook)
```

**Two response paths:**

1. **Relay path (primary)** — when your MacBook is reachable via Tailscale Funnel, Cloud Run forwards the message to the local relay server, which feeds it to `claude --print` on your MacBook. You get full local PAI context, current working directory, and any Claude Code capabilities.

2. **Fallback path** — when the MacBook is offline or the relay is unreachable, Cloud Run answers directly using the encrypted context pack stored in GCS, with web search via Anthropic's `web_search_20250305` tool.

**Context pack** — a distilled JSON snapshot of your PAI identity, goals, and preferences. Generated locally from your live PAI memory files, encrypted with AES-256-GCM, and pushed to GCS. The Cloud Run server reads it at startup and on `/sync`.

**Conversation log** — every exchange is appended to a daily JSONL file in GCS regardless of which path handled it. Each request loads the last 20 entries from today plus the last 10 from yesterday as a sliding context window.

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

The relay lets Cloud Coco route messages to your local Claude Code instance when your MacBook is online.

**a. Generate a bearer token and configure Tailscale Funnel:**

```bash
# Generate a strong random token
openssl rand -hex 32

# Store it in Secret Manager
echo -n "YOUR_TOKEN" | gcloud secrets create RELAY_BEARER_TOKEN --data-file=- --project=YOUR_PROJECT_ID
echo -n "https://YOUR-MACHINE.tailbfcc6e.ts.net" | gcloud secrets create RELAY_URL --data-file=- --project=YOUR_PROJECT_ID

# Add to ~/.env.cloud-coco
echo "RELAY_BEARER_TOKEN=YOUR_TOKEN" >> ~/.env.cloud-coco

# Enable Tailscale Funnel (persists across reboots)
tailscale funnel --bg localhost:3001
```

**b. Install the relay as a launchd service (auto-starts at login):**

```bash
# Install the plist (edit paths if needed)
cp ~/Library/LaunchAgents/com.cloud-coco.relay.plist ~/Library/LaunchAgents/com.cloud-coco.relay.plist
launchctl load ~/Library/LaunchAgents/com.cloud-coco.relay.plist

# Tail logs
tail -f /tmp/cloud-coco-relay.log /tmp/cloud-coco-relay.error.log
```

The plist template is embedded at the bottom of `tools/relay-server.ts`. The relay binds to `127.0.0.1:3001` only — Tailscale Funnel is the sole external ingress.

**c. Store the webhook secret:**

```bash
openssl rand -hex 32 | gcloud secrets create TELEGRAM_WEBHOOK_SECRET --data-file=- --project=YOUR_PROJECT_ID
```

### 5. Build and push the container image

```bash
PROJECT_ID=$(gcloud config get project)
REGION=us-central1
IMAGE="gcr.io/${PROJECT_ID}/cloud-coco"

gcloud auth configure-docker gcr.io
docker build --platform linux/amd64 -t ${IMAGE}:latest .
docker push ${IMAGE}:latest
```

> **Apple Silicon note:** `--platform linux/amd64` is required — Cloud Run only accepts `amd64` images.

### 6. Deploy to Cloud Run

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
  --set-secrets=CLAUDE_API_KEY=CLAUDE_API_KEY:latest,TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,CONTEXT_PACK_KEY=CONTEXT_PACK_KEY:latest,ALLOWED_CHAT_IDS=ALLOWED_CHAT_IDS:latest,TELEGRAM_WEBHOOK_SECRET=TELEGRAM_WEBHOOK_SECRET:latest,RELAY_URL=RELAY_URL:latest,RELAY_BEARER_TOKEN=RELAY_BEARER_TOKEN:latest \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=60s \
  --allow-unauthenticated
```

### 7. Register the Telegram webhook

```bash
SERVICE_URL=$(gcloud run services describe cloud-coco --region=${REGION} --format='value(status.url)')
WEBHOOK_SECRET=$(gcloud secrets versions access latest --secret=TELEGRAM_WEBHOOK_SECRET --project=${PROJECT_ID})

curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${SERVICE_URL}/webhook\",\"secret_token\":\"${WEBHOOK_SECRET}\"}"
```

Open Telegram, find your bot, and send `/start`.

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction and command list |
| `/status` | Context pack age, relay state (online/offline), today's exchange count |
| `/sync` | Reload context pack from GCS (after running `bun sync` locally) |

Any other message is treated as a conversation. If the relay is online it routes to your MacBook Claude; otherwise it answers from the context pack with web search.

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
export RELAY_URL=...               # optional
export RELAY_BEARER_TOKEN=...      # optional

bun start
```

The server listens on port 8080. Use [ngrok](https://ngrok.com/) or Tailscale Funnel to expose it for Telegram webhook testing.

## Project structure

```
cloud-coco/
├── src/
│   ├── server.ts        # Bun HTTP server, webhook handler, relay routing, command handling
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

- **Webhook secret** — every Telegram update is validated with `X-Telegram-Bot-Api-Secret-Token` before any processing. Invalid tokens get a silent 200 (no information leak to attackers).
- **Relay bearer token** — Cloud Run presents a Bearer token to the relay server. Compared with `timingSafeEqual` to prevent timing attacks. Relay rejects any token under 16 characters at startup.
- **Relay bind** — the relay binds to `127.0.0.1` only. Tailscale Funnel is the sole external ingress; direct LAN access is impossible.
- **Prompt injection hardening** — user text is passed to `claude` via stdin wrapped in `<<<MSG>>>/<<<END>>>` sentinels. Any message containing those sentinel strings is rejected before reaching the model.
- **Scrubbed child env** — the relay's `claude` subprocess only inherits `PATH`, `HOME`, and `USER`. No API keys, GCP credentials, or GitHub tokens can leak into the subprocess.
- **No shell interpolation** — `Bun.spawn` uses an explicit argv array; user text never appears on a command line.
- **GCS encryption** — context pack is AES-256-GCM encrypted at rest. Key lives only in Secret Manager and `~/.env.cloud-coco`.
- **Allowlist** — `ALLOWED_CHAT_IDS` is checked before any API call; unknown chat IDs receive no response and incur no cost.
- Never commit `~/.env.cloud-coco` or any file containing actual credentials.
