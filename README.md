# Cloud Coco

A cloud-resident personal assistant running as a Telegram bot on GCP Cloud Run. Cloud Coco is the always-on counterpart to a local [PAI](https://github.com/sverze/pai) instance — it carries your identity, goals, and preferences into the cloud so you can query your assistant from anywhere, without your MacBook being open.

## How it works

```
MacBook (PAI)                        GCP
─────────────────                    ────────────────────────────────────
~/.claude/PAI/          bun sync     GCS bucket
  USER/                ──────────►  context-pack.json.enc  (AES-256-GCM)
  MEMORY/KNOWLEDGE/                 conversations/
                                      YYYY-MM-DD.jsonl
                                           │
                                      Cloud Run
                                      (Bun server)
                                           │
                                      Telegram bot
                                      (webhook)
```

**Context pack** — a distilled JSON snapshot of your PAI identity, goals, and preferences. Generated locally from your live PAI memory files, encrypted, and pushed to GCS. The Cloud Run server reads it at startup and on `/sync`.

**Conversation log** — every exchange is appended to a daily JSONL file in GCS. Each request loads the last 20 entries from today plus the last 10 from yesterday as a sliding context window.

**Context freshness** — if the context pack is older than 72 hours, the bot injects a staleness warning and `/status` flags it. Run `bun sync` locally to refresh.

## Prerequisites

- GCP account with billing enabled
- [gcloud CLI](https://cloud.google.com/sdk/docs/install) authenticated (`gcloud auth login`)
- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)
- [Docker](https://docs.docker.com/get-docker/) with BuildKit (for the container image)
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

This creates a GCP project, GCS bucket, service account, Artifact Registry repo, and stores all secrets in Secret Manager. It writes `~/.env.cloud-coco` with the generated encryption key and bucket name — keep this file safe and never commit it.

### 3. Push your first context pack

```bash
bun install
bun sync
```

This reads your local PAI memory files, distils them into a context pack via Claude, encrypts it, and uploads to GCS. Run this from the `cloud-coco/` directory after setting `PAI_DIR` if your PAI lives somewhere other than `~/.claude/PAI`.

```bash
# Optional — if PAI is not at the default location
PAI_DIR=/path/to/your/PAI bun sync
```

### 4. Build and push the container image

```bash
PROJECT_ID=$(gcloud config get project)
REGION=us-central1
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-coco/cloud-coco"

gcloud auth configure-docker ${REGION}-docker.pkg.dev
docker build --platform linux/amd64 -t ${IMAGE}:latest .
docker push ${IMAGE}:latest
```

> **Apple Silicon note:** the `--platform linux/amd64` flag is required. Cloud Run only accepts `amd64` images.

### 5. Deploy to Cloud Run

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
  --set-secrets=CLAUDE_API_KEY=CLAUDE_API_KEY:latest,TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,CONTEXT_PACK_KEY=CONTEXT_PACK_KEY:latest,ALLOWED_CHAT_IDS=ALLOWED_CHAT_IDS:latest \
  --min-instances=0 \
  --max-instances=1 \
  --memory=512Mi \
  --cpu=1 \
  --timeout=30s \
  --no-allow-unauthenticated
```

### 6. Register the Telegram webhook

```bash
SERVICE_URL=$(gcloud run services describe cloud-coco --region=${REGION} --format='value(status.url)')

# Make the service reachable by Telegram
gcloud run services add-iam-policy-binding cloud-coco \
  --region=${REGION} \
  --member=allUsers \
  --role=roles/run.invoker

# Register webhook
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     -d "url=${SERVICE_URL}/webhook"
```

Open Telegram, find your bot by username, and send `/start`.

## Bot commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction and command list |
| `/status` | Context pack age, last sync time, today's exchange count |
| `/sync` | Reload context pack from GCS (after running `bun sync` locally) |

Any other message is treated as a conversation and routed to Claude with your full PAI context.

## Keeping context fresh

The context pack is a snapshot — it doesn't update automatically. Run `bun sync` from your MacBook whenever your PAI memory changes significantly, then send `/sync` in Telegram to reload the pack without redeploying.

```bash
bun sync          # push updated context pack to GCS
# then in Telegram:
/sync             # reload from GCS into the running container
```

## Local development

```bash
# Set required env vars
export CLAUDE_API_KEY=...
export TELEGRAM_BOT_TOKEN=...
export CONTEXT_PACK_KEY=...   # 64 hex chars
export ALLOWED_CHAT_IDS=...
export MEMORY_DIR=./memory    # local path for conversation logs

bun start
```

The server listens on port 8080. Use [ngrok](https://ngrok.com/) or similar to expose it for Telegram webhook testing locally.

## Project structure

```
cloud-coco/
├── src/
│   ├── server.ts        # Bun HTTP server, webhook handler, command routing
│   ├── secrets.ts       # GCP Secret Manager (Cloud Run) or env vars (local)
│   ├── memory.ts        # GCS context pack decrypt, conversation log read/write
│   ├── system-prompt.ts # Builds Claude system prompt from context pack
│   ├── claude.ts        # Anthropic SDK wrapper
│   ├── telegram.ts      # Raw fetch Telegram client
│   └── types.ts         # Shared TypeScript interfaces
├── tools/
│   └── sync-context-pack.ts  # MacBook push script (bun sync)
├── scripts/
│   └── bootstrap.sh     # One-time GCP project setup
├── Dockerfile
├── .env.example         # Template for ~/.env.cloud-coco
└── tsconfig.json
```

## Security notes

- The GCS bucket is not public — Cloud Run accesses it via a dedicated service account with `storage.objectAdmin` scoped to that bucket only.
- All secrets are stored in GCP Secret Manager; nothing is baked into the container image.
- The context pack is AES-256-GCM encrypted at rest. The encryption key lives only in Secret Manager and `~/.env.cloud-coco`.
- The bot allowlist (`ALLOWED_CHAT_IDS`) is checked before any API call — unknown chat IDs receive no response and incur no cost.
- Never commit `~/.env.cloud-coco` or any file containing your actual credentials.
