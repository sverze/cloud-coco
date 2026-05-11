# Cloud Coco — Product Requirements Document

> Always-on cloud PA powered by PAI, hosted on GCP Cloud Run with GCS-backed memory.
> Status: Draft | Author: sverze | Date: 2026-05-09

---

## 1. Vision

Extend PAI's local DA (Coco) into a cloud-resident assistant that is reachable 24/7 — from any device, any network — without requiring the MacBook to be on. Cloud Coco shares identity and memory with local Coco, responds via Telegram, and keeps itself in sync with the local PAI memory system through a push-based context pack model.

The design principle: **Cloud Coco is a read/write cache of local PAI, not a replica.** It knows what it knows and says so.

---

## 2. Goals

| Goal | Success Criteria |
|---|---|
| Always reachable | Responds to Telegram messages when MacBook is off |
| Persistent memory | Remembers user preferences, active goals, recent conversations across container restarts |
| Local PAI sync | Context pack updated within minutes of a local PAI session ending |
| Cost-effective | < $5/month total GCP spend |
| Secure | No credentials on VM that can initiate inbound connections to MacBook |

---

## 3. Non-Goals

- Replacing local Coco (local PAI remains primary, richer, full-featured)
- Full PAI feature parity (no skills, hooks, or algorithm in cloud)
- Real-time bidirectional sync (push-on-session-end is sufficient for MVP)
- iMessage integration (fragile, defer indefinitely)
- Multi-user support

---

## 4. Architecture

### 4.1 System Diagram

```
[Telegram] ──webhook──▶ [Cloud Run container]
                               │
                    reads on cold start ▼
                        [GCS Bucket: cloud-coco-memory]
                               │
                    /memory/context-pack.json.enc   ← hot path (always loaded)
                    /memory/bm25-index.bin           ← warm path (deep queries only)
                    /memory/conversations/YYYY-MM-DD.jsonl
                               ▲
                    push on session end
                               │
                    [MacBook — local PAI]
                    WorkCompletionLearning.hook.ts
                    SatisfactionCapture.hook.ts
                               │
                    Phase 2: Tailscale mesh
                               │
                    [local PAI daemon — read-only, HMAC-signed]
                    MemoryRetriever.ts on-demand queries
```

### 4.2 Component Responsibilities

| Component | Responsibility |
|---|---|
| Cloud Run container | Telegram webhook handler, Claude API call, memory read/write |
| GCS bucket | Durable memory store — context pack, BM25 index, conversation log |
| GCS FUSE mount | Presents GCS bucket as `/memory` filesystem path inside container |
| Context pack | Single encrypted JSON — distilled PAI facts, loaded on every cold start |
| BM25 index | Pre-built retrieval index — loaded only for deep memory queries |
| Conversation log | Append-only JSONL per day — written after each exchange |
| MacBook push hook | Reconciles context pack + rebuilds BM25 index after local PAI sessions |

---

## 5. Memory Model

### 5.1 Two-Tier Design

Cloud Coco's memory is intentionally tiered to survive Cloud Run's stateless lifecycle:

**Hot path — loaded on every cold start (target: < 500ms)**
```json
{
  "version": "1.0",
  "generated": "2026-05-09T09:00:00Z",
  "identity": {
    "name": "sverze",
    "timezone": "America/Los_Angeles",
    "communication_style": "..."
  },
  "active_goals": ["..."],
  "preferences": { "...": "..." },
  "recent_summary": "30-day rolling summary of decisions and context...",
  "last_sync": "2026-05-09T08:55:00Z"
}
```

Stored as AES-256-GCM encrypted JSON. Key in GCP Secret Manager.

**Warm path — loaded on deep query only (target: < 1s)**
- Pre-built BM25 index over MEMORY/KNOWLEDGE/ and MEMORY/LEARNING/ distillations
- Stored as single binary blob on GCS
- Rebuilt by MacBook hook on session end, uploaded to GCS

**Conversation log — written after each exchange**
- One JSONL file per day: `/memory/conversations/YYYY-MM-DD.jsonl`
- Each line: `{ "ts": "...", "role": "user"|"assistant", "content": "..." }`
- Written atomically: temp file → same-directory rename (GCS FUSE atomic)

### 5.2 What Is NOT in Cloud Memory

For security, the following local PAI data is never uploaded to GCS:
- Raw CONTACTS.md
- HEALTH/ directory
- FINANCES/ directory
- Full conversation transcripts (only summarised rolling window)

### 5.3 Context Pack Sync

The MacBook push hook runs after:
1. `WorkCompletionLearning` fires (PAI work session ends)
2. `SatisfactionCapture` fires
3. Manually via `bun tools/sync-context-pack.ts`

The hook:
1. Reads `MEMORY/KNOWLEDGE/`, `MEMORY/LEARNING/`, `USER/` files
2. Distills to ~150 facts + 30-day rolling summary
3. Encrypts with AES-256-GCM (key from local Secret Manager / env)
4. Uploads `context-pack.json.enc` to GCS
5. Rebuilds BM25 index, uploads `bm25-index.bin` to GCS

---

## 6. Compute & Hosting

### 6.1 Cloud Run Configuration

```yaml
service: cloud-coco
image: gcr.io/PROJECT/cloud-coco:latest
region: us-central1
min-instances: 0          # scale to zero when idle
max-instances: 1          # single instance, no concurrency issues
memory: 512Mi
cpu: 1
timeout: 30s
volumes:
  - name: memory
    gcs:
      bucket: cloud-coco-memory
      readonly: false
volumeMounts:
  - name: memory
    mountPath: /memory
env:
  - CLAUDE_API_KEY: from Secret Manager
  - TELEGRAM_BOT_TOKEN: from Secret Manager
  - CONTEXT_PACK_KEY: from Secret Manager
  - ALLOWED_CHAT_IDS: from Secret Manager
```

### 6.2 Cold Start Profile

| Step | Duration |
|---|---|
| Container pull (cached layer) | ~0.5-1s |
| GCS FUSE mount init | ~0.5-1s |
| `context-pack.json.enc` read + decrypt | ~200-400ms |
| Bun server ready | ~200ms |
| **Total** | **~1.5-3s** |

Telegram shows "typing..." — acceptable for first message after idle period.

### 6.3 Cost Model

| Resource | Usage | Cost |
|---|---|---|
| Cloud Run CPU | ~100ms/request, ~50 requests/day | < $0.50/mo |
| Cloud Run memory | 512MB × billed duration | < $0.20/mo |
| GCS storage | < 100MB (context pack + index + logs) | < $0.01/mo |
| GCS operations | ~200 reads + writes/day | < $0.05/mo |
| Secret Manager | 4 secrets, ~200 accesses/day | Free tier |
| GCS egress | Minimal | < $0.05/mo |
| **Total** | | **< $1/mo** |

---

## 7. Security

### 7.1 Hard Rules

1. **VPS never initiates connections to MacBook.** MacBook is always the initiator.
2. Context pack contains only distilled facts — no raw sensitive data.
3. Context pack is AES-256-GCM encrypted at rest and in transit.
4. Telegram: validate `chat_id` allowlist on every request before any processing.
5. All secrets via GCP Secret Manager — never in environment variables in source.
6. Cloud Run service account: least privilege (GCS read/write on bucket only, Secret Manager accessor).

### 7.2 Allowed Chat IDs

Stored in Secret Manager as comma-separated string. Validated at webhook entry point — requests from unknown chat IDs are silently dropped (no response leaks bot existence).

---

## 8. Telegram Interface

### 8.1 Commands

| Command | Behaviour |
|---|---|
| `/start` | Greeting + capability summary |
| `/sync` | Trigger context pack reload from GCS (picks up latest push) |
| `/status` | Show context pack age, last sync time, conversation count |
| `/memory [query]` | Explicit BM25 memory search (loads warm path) |
| Free text | Conversational response using context pack |

### 8.2 System Prompt

Cloud Coco uses a condensed version of the local Coco system prompt:
- DA identity (name, personality, voice style)
- Injected context pack facts
- Rolling conversation window (last 10 exchanges from today's log)
- Current date/time

Does not include: skills, algorithm, hooks, or tool definitions (not applicable in cloud).

---

## 9. Phase Plan

### Phase 1 — MVP (target: 1 weekend)

- [ ] GCP project setup, GCS bucket, Secret Manager secrets
- [ ] Cloud Run service with GCS FUSE volume mount
- [ ] Bun HTTP server — Telegram webhook handler
- [ ] Context pack schema + AES-256-GCM encryption/decryption
- [ ] System prompt builder (injects context pack)
- [ ] Claude API call (claude-sonnet-4-6, streaming off for simplicity)
- [ ] Conversation log writer (atomic write to GCS)
- [ ] MacBook push script: `bun tools/sync-context-pack.ts`
- [ ] Manual trigger first — no hook integration yet
- [ ] Dockerfile + Cloud Run deploy via `gcloud`

### Phase 2 — Hook Integration

- [ ] PAI hook: auto-push context pack on `WorkCompletionLearning`
- [ ] PAI hook: auto-push context pack on `SatisfactionCapture`
- [ ] BM25 index build + upload in push script
- [ ] `/memory` command with warm-path BM25 retrieval

### Phase 3 — Live Context (optional)

- [ ] Tailscale mesh: MacBook + Cloud Run (via sidecar or outbound only)
- [ ] Local read-only PAI daemon (HMAC-signed, rate-limited)
- [ ] On-demand MemoryRetriever.ts queries for deep context
- [ ] `launchd` service for tunnel daemon (survives sleep/wake)

---

## 10. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Bun | PAI standard, fast cold starts |
| Language | TypeScript | PAI standard |
| Cloud | GCP | Cloud Run + GCS FUSE free tier viability |
| Container registry | Artifact Registry (GCP) | Native Cloud Run integration |
| Memory storage | GCS + FUSE mount | Durable, cheap, POSIX-ish filesystem interface |
| Secrets | GCP Secret Manager | Free tier, native IAM |
| Encryption | Node crypto (AES-256-GCM) | Built-in, no extra deps |
| Telegram | `node-telegram-bot-api` or raw webhook | Lightweight |
| Claude API | `@anthropic-ai/sdk` via PAI Inference.ts pattern | PAI standard |
| CI/CD | Cloud Build or GitHub Actions → `gcloud run deploy` | Simple |

---

## 11. Open Questions

1. **Context pack key rotation** — how often, what triggers it?
2. **Conversation log retention** — 30 days rolling, then delete?
3. **Phase 3 Tailscale** — Cloud Run supports outbound network; Tailscale in a container requires NET_ADMIN capability which Cloud Run doesn't allow. Workaround: use a Cloud Run sidecar (gen2) or proxy via a Cloud NAT static IP that the local daemon allowlists.
4. **Multi-device** — if sverze uses iPad/mobile Telegram, same bot handles it (chat_id allowlist just includes the second device).
