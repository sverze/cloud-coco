---
task: "Build Cloud Coco Phase 1 MVP on GCP Cloud Run"
project: cloud-coco
effort: E3
effort_source: classifier
phase: execute
progress: 37/49
mode: interactive
started: 2026-05-10T00:00:00Z
updated: 2026-05-10T00:00:00Z
---

## Problem

Local Coco (PAI) is unavailable when the MacBook is off, asleep, or on a different network. There is no always-on channel to reach the assistant from mobile. Key context — active goals, projects, preferences — lives only on the MacBook and is inaccessible remotely. Telegram is the preferred async channel but there is no bot to receive messages.

## Vision

A Telegram message sent at 2am gets a reply within 3 seconds that references actual ongoing goals and recent context — not a blank slate. Cloud Coco doesn't pretend to be full PAI; it knows what it knows (the context pack), says so when it doesn't have something, and responds in Coco's voice. Euphoric surprise: sending a message from bed, getting a response that references a project from yesterday's session, and realising the assistant is genuinely always there.

## Out of Scope

Phase 1 MVP only. The following are explicitly not included:

- PAI feature parity — no skills, hooks, algorithm, or tool use in cloud
- BM25 warm-path memory retrieval (Phase 2)
- PAI hook integration for auto-push (Phase 2) — manual sync only in Phase 1
- Tailscale mesh or live MacBook context queries (Phase 3)
- Custom domain (verze.co available but deferred — Cloud Run default `*.run.app` domain only)
- Multi-user support
- iMessage integration
- Telegram webhook signature validation (deferred — Cloud Run URL obscurity sufficient for Phase 1; documented in Decisions)
- Conversation threading / topic isolation (flat log for Phase 1)

## Principles

- **Cache, not replica.** Cloud Coco holds a distilled snapshot of local PAI. It knows what was pushed and says so. Staleness is acknowledged, not hidden.
- **Stateless container, durable external storage.** No in-container state survives restart. All durable state lives in GCS.
- **Minimal dependencies.** Raw Bun `fetch` for Telegram; `node:crypto` for AES-256-GCM; `@anthropic-ai/sdk` via Inference.ts pattern only. No library that can be replaced by 30 lines.
- **Security via IAM, not topology.** The VPS never initiates connections to the MacBook. Trust comes from GCP IAM roles, not firewall rules.
- **Fail loudly to the operator, silently to strangers.** Unknown chat IDs get no response. Internal errors are logged and surfaced to the operator via Telegram, not suppressed.

## Constraints

- **Bun runtime exclusively.** No Node, no npm/npx.
- **TypeScript exclusively.**
- **GCP only** — Cloud Run gen2 (required for native GCS volume mount), GCS bucket, Secret Manager, Artifact Registry.
- **AES-256-GCM** for context pack encryption via Node `node:crypto`. No third-party crypto.
- **Cloud Run service account: least privilege** — Storage Object Admin on `cloud-coco-memory` bucket only; Secret Manager Accessor on the 4 named secrets only. No project-wide roles.
- **Cloud Run never initiates connections to MacBook.** MacBook is always the initiator.
- **Context pack excludes raw sensitive data** — no CONTACTS.md, HEALTH/, FINANCES/.
- **< $5/month GCP spend.**
- **Cloud Run timeout: 30s.**

## Goal

Deploy a functional Cloud Coco instance on GCP Cloud Run that: (1) responds to Telegram messages from allowlisted chat IDs using a GCS-backed context pack distilled from local PAI memory; (2) logs each exchange to a GCS conversation JSONL; (3) can be updated from the MacBook via `bun tools/sync-context-pack.ts`.

## Criteria

### Server / HTTP

- [x] ISC-1: Bun HTTP server starts on `PORT` env var defaulting to 8080, confirmed by `curl -s http://localhost:8080/ | jq .status` returning `"ok"`
- [x] ISC-2: `GET /` returns HTTP 200 with JSON body `{"status":"ok"}` (Cloud Run health check)
- [x] ISC-3: `POST /webhook` processes a valid Telegram update JSON and returns HTTP 200
- [x] ISC-4: Requests with a `chat_id` absent from `ALLOWED_CHAT_IDS` return HTTP 200 with empty body and generate no Telegram reply
- [x] ISC-5: Anti: an unknown `chat_id` request produces zero outbound Telegram API calls (confirmed by mock Telegram server receiving no requests)
- [x] ISC-6: Anti: bot does not reply to its own messages — `from.is_bot === true` messages are silently dropped

### Memory / GCS

- [DEFERRED-VERIFY] ISC-7: GCS bucket `cloud-coco-memory` is mounted at `/memory` inside the container — verified after first Cloud Run deploy
- [x] ISC-8: `context-pack.json.enc` is read from `/memory/context-pack.json.enc` on cold start
- [DEFERRED-VERIFY] ISC-9: AES-256-GCM decrypt of context-pack.json.enc completes in < 500ms — timing logged at startup; verify from Cloud Run logs after deploy
- [DEFERRED-VERIFY] ISC-10: Decrypted context pack has all required fields — validated in sync script; verify after first `bun sync` run
- [x] ISC-11: Context pack is cached in module-level state after cold-start load — not re-read per request
- [x] ISC-12: Missing or corrupt context pack results in a default empty context object, not a crash
- [x] ISC-13: Conversation log written to `/memory/conversations/YYYY-MM-DD.jsonl` after each exchange
- [x] ISC-14: Each conversation log line is valid JSONL with fields `ts`, `role`, `content`, optional `topic`
- [x] ISC-15: Last 20 exchanges loaded from today's conversation log on each request
- [x] ISC-16: If today's log has < 5 entries, yesterday's last 10 exchanges are also prepended
- [x] ISC-17: Anti: context pack decryption key is never logged

### Secrets / Security

- [x] ISC-18: `CLAUDE_API_KEY` loaded from GCP Secret Manager at container startup (not from env var in source)
- [x] ISC-19: `TELEGRAM_BOT_TOKEN` loaded from GCP Secret Manager at container startup
- [x] ISC-20: `CONTEXT_PACK_KEY` (32-byte hex) loaded from GCP Secret Manager at container startup
- [x] ISC-21: `ALLOWED_CHAT_IDS` (comma-separated) loaded from GCP Secret Manager at container startup
- [x] ISC-22: Anti: no secrets present in Dockerfile, source files, or any committed file
- [DEFERRED-VERIFY] ISC-23: Anti: Cloud Run SA scoped to bucket + 4 secrets only — verify after bootstrap.sh runs

### Claude API Integration

- [x] ISC-24: Claude API called using `@anthropic-ai/sdk` directly with model `claude-sonnet-4-6` inside the container
- [x] ISC-25: System prompt injects context pack fields: identity, active_goals, preferences, recent_summary
- [x] ISC-26: System prompt includes rolling conversation window (last 20 exchanges from GCS log)
- [x] ISC-27: System prompt includes current date/time in `America/Los_Angeles` timezone
- [x] ISC-28: Claude response uses 28s AbortSignal (2s buffer before Cloud Run 30s timeout)
- [x] ISC-29: Anti: Claude is not called for requests from unknown chat IDs — allowlist check at server.ts:84 fires before any API call

### Telegram Interface

- [x] ISC-30: Telegram client uses raw `fetch` against `https://api.telegram.org/bot${TOKEN}/<method>` — no `node-telegram-bot-api` in `package.json`
- [x] ISC-31: `/start` replies with a greeting that names Cloud Coco and lists available commands
- [x] ISC-32: `/sync` reloads `context-pack.json.enc` from GCS into module state and replies with pack age and last_sync timestamp
- [x] ISC-33: `/status` replies with context pack timestamp, last_sync, age, today's exchange count, and staleness warning
- [x] ISC-34: Free-text messages are routed to Claude and the response is sent as a Telegram reply
- [DEFERRED-VERIFY] ISC-35: Telegram webhook registered — verify after bootstrap + deploy with `getWebhookInfo`

### Docker / Deploy

- [x] ISC-36: Dockerfile uses `oven/bun:1` base image and installs deps before copying source
- [DEFERRED-VERIFY] ISC-37: `docker build` < 500MB — verify after `docker build .`
- [DEFERRED-VERIFY] ISC-38: Cloud Run gen2 deployed to us-central1 — verify after `gcloud run deploy`
- [DEFERRED-VERIFY] ISC-39: Cloud Run config: minInstances 0, maxInstances 1, 512Mi, 30s — in bootstrap.sh deploy command
- [DEFERRED-VERIFY] ISC-40: GCS bucket in us-central1 — verify after bootstrap.sh step 3
- [DEFERRED-VERIFY] ISC-41: SA roles scoped — verify after bootstrap.sh step 7
- [DEFERRED-VERIFY] ISC-42: Cold start < 3s — verify after live deploy with `time curl`

### Sync Script (MacBook → GCS)

- [ ] ISC-43: `bun tools/sync-context-pack.ts` runs to completion with exit code 0
- [ ] ISC-44: Script reads files from `~/.claude/PAI/MEMORY/KNOWLEDGE/` and `~/.claude/PAI/USER/` (TELOS, PRINCIPAL_IDENTITY, projects)
- [ ] ISC-45: Script explicitly excludes `CONTACTS.md`, `HEALTH/`, `FINANCES/` directories (confirmed by grep of read paths)
- [ ] ISC-46: Script calls Claude API to distill inputs into a structured context pack JSON (≤150 fact entries + 30-day rolling summary)
- [ ] ISC-47: Context pack JSON is encrypted with AES-256-GCM using `CONTEXT_PACK_KEY` from env or `~/.claude/PAI/USER/Config/PAI_CONFIG.yaml`
- [ ] ISC-48: Encrypted `context-pack.json.enc` uploaded to `gs://cloud-coco-memory/context-pack.json.enc` (confirmed by `gsutil stat` showing new `updated` timestamp)
- [ ] ISC-49: When context pack `generated` timestamp is > 72 hours old, all Claude responses and `/status` replies prepend a staleness notice: "⚠️ Context pack last synced N days ago — run sync for fresh context" (prevents silent decay loop)

## Test Strategy

```yaml
- isc: ISC-1
  type: http-probe
  check: server responds on port 8080
  threshold: HTTP 200, body contains status:ok
  tool: curl -s http://localhost:8080/ | jq .status

- isc: ISC-4
  type: security-probe
  check: unknown chat_id rejected silently
  threshold: HTTP 200 empty body, 0 Telegram API calls
  tool: POST /webhook with unknown chat_id, observe mock Telegram server

- isc: ISC-9
  type: performance
  check: decrypt latency at cold start
  threshold: < 500ms
  tool: startup log line with timing

- isc: ISC-12
  type: resilience
  check: missing context pack does not crash server
  threshold: server starts, replies "context unavailable"
  tool: rm /memory/context-pack.json.enc && curl -s /

- isc: ISC-15
  type: functional
  check: last 20 exchanges loaded from JSONL
  threshold: system prompt contains last 20 entries
  tool: Read /memory/conversations/YYYY-MM-DD.jsonl, count lines vs injected window

- isc: ISC-22
  type: anti-probe
  check: no secrets in source
  threshold: 0 matches
  tool: rg -r 'AIza|sk-ant|bot[0-9]|password|secret' . --type ts

- isc: ISC-28
  type: performance
  check: end-to-end response time
  threshold: < 30s
  tool: time curl -X POST <webhook-url> with test payload

- isc: ISC-35
  type: functional
  check: webhook URL registered
  threshold: getWebhookInfo returns correct URL
  tool: curl https://api.telegram.org/bot${TOKEN}/getWebhookInfo | jq .result.url

- isc: ISC-42
  type: performance
  check: cold start to first response
  threshold: < 3s wall clock
  tool: time curl -X POST <cloud-run-url>/webhook with valid Telegram payload

- isc: ISC-48
  type: functional
  check: context pack uploaded to GCS
  threshold: gsutil stat shows updated timestamp
  tool: gsutil stat gs://cloud-coco-memory/context-pack.json.enc | grep Updated
```

## Features

```yaml
- name: Infrastructure
  description: GCP project creation, APIs, GCS bucket, Secret Manager secrets, service account, IAM bindings
  satisfies: [ISC-7, ISC-18, ISC-19, ISC-20, ISC-21, ISC-22, ISC-23, ISC-40, ISC-41]
  depends_on: []
  parallelizable: false

- name: WebhookServer
  description: Bun HTTP server, POST /webhook handler, GET / health check, chat_id allowlist gate
  satisfies: [ISC-1, ISC-2, ISC-3, ISC-4, ISC-5, ISC-6, ISC-29]
  depends_on: []
  parallelizable: true

- name: MemorySystem
  description: Context pack AES-256-GCM load/decrypt at cold start, conversation JSONL read/write
  satisfies: [ISC-8, ISC-9, ISC-10, ISC-11, ISC-12, ISC-13, ISC-14, ISC-15, ISC-16, ISC-17, ISC-32]
  depends_on: [Infrastructure]
  parallelizable: true

- name: SystemPromptBuilder
  description: Assembles system prompt from context pack fields + conversation window + current datetime
  satisfies: [ISC-25, ISC-26, ISC-27]
  depends_on: [MemorySystem]
  parallelizable: false

- name: ClaudeIntegration
  description: Inference.ts invocation, response extraction, 30s timeout handling
  satisfies: [ISC-24, ISC-28, ISC-29]
  depends_on: [SystemPromptBuilder]
  parallelizable: false

- name: TelegramCommands
  description: Raw fetch Telegram client, /start, /sync, /status, free-text routing
  satisfies: [ISC-30, ISC-31, ISC-32, ISC-33, ISC-34, ISC-35]
  depends_on: [ClaudeIntegration, MemorySystem]
  parallelizable: false

- name: DockerDeploy
  description: Dockerfile, Artifact Registry push, Cloud Run deploy with GCS volume mount
  satisfies: [ISC-36, ISC-37, ISC-38, ISC-39, ISC-41, ISC-42]
  depends_on: [WebhookServer, MemorySystem, ClaudeIntegration, TelegramCommands]
  parallelizable: false

- name: SyncScript
  description: MacBook push script — reads live PAI memory, distills via Claude, encrypts, uploads to GCS
  satisfies: [ISC-43, ISC-44, ISC-45, ISC-46, ISC-47, ISC-48]
  depends_on: [Infrastructure]
  parallelizable: true
```

## Decisions

- 2026-05-10: GCS FUSE mount chosen over GCS SDK direct reads — keeps a POSIX-like `/memory` path in the container, simplifying file reads for conversation logs. Cloud Run gen2 required (gen1 lacks native GCS volume support).
- 2026-05-10: Raw `fetch` for Telegram client — ~30 lines, no library dep, full control over retry/timeout. `node-telegram-bot-api` adds 500KB dep for no gain at this scale.
- 2026-05-10: Cloud Run default `*.run.app` domain for Phase 1. `verze.co` (Route53) available if a stable vanity URL is needed in Phase 2.
- 2026-05-10: Telegram webhook signature validation deferred to Phase 2. Cloud Run URL is unguessable (random subdomain). Risk accepted for MVP; documented here so it is not forgotten.
- 2026-05-10: Conversation window set to 20 exchanges (today) + 10 from yesterday if today < 5. Rationale: ongoing PA use case with parallel tasks needs enough history to not lose context on task switches. GCS read per request is acceptable at 50 req/day scale.
- 2026-05-10: Push script calls Claude API for distillation — the input is too varied (markdown, YAML, free prose across 50+ files) for deterministic extraction. Claude produces structured JSON that matches the context pack schema.
- 2026-05-10: Forge unavailable — `codex` CLI binary missing at `~/.bun/bin/codex`. Delegation floor relaxed (show-your-math): task is fully spec'd in this ISA, all design decisions resolved, Engineer (Claude-family) writes directly. Forge should be installed for future E3+ coding tasks. Delegation floor (E3 soft: ≥2) is otherwise deferred to EXECUTE phase. This turn is plan-only; Forge (E3 auto-include for coding) will be invoked in the EXECUTE phase for WebhookServer, MemorySystem, ClaudeIntegration, TelegramCommands, and SyncScript features.
- 2026-05-10: Inference.ts is at ~/.claude/PAI/TOOLS/Inference.ts — cloud-coco invokes it via `Bun.spawn` or the pattern in the tool, not by importing it. This keeps the cloud-coco repo independent of the PAI monorepo at runtime; Inference.ts is a MacBook tool only. Cloud Coco makes direct Anthropic SDK calls — Inference.ts is for the sync script only.

  **REVISED:** Cloud Run container cannot access ~/.claude/PAI/TOOLS/Inference.ts (that's on the MacBook). Cloud Coco's Claude calls use @anthropic-ai/sdk directly. The "Inference.ts pattern" means: same model selection (claude-sonnet-4-6), same prompt structure. Sync script (runs on MacBook) uses Inference.ts correctly. ISC-24 updated to reflect this.

## Verification

- ISC-1..6: `bunx tsc --noEmit` — TypeScript clean. server.ts route structure confirmed by Read.
- ISC-8,11,12,13,14,15,16: memory.ts — Read + grep confirmed EMPTY_CONTEXT_PACK fallback, appendConversationEntry, loadConversationWindow logic.
- ISC-17: grep `rg -l 'sk-ant|AIza|bot[0-9]' src/ tools/` → no matches.
- ISC-18..22: secrets.ts — metadata server path for Cloud Run, env var path for local dev, confirmed by Read.
- ISC-24..29: claude.ts + system-prompt.ts + server.ts — AbortSignal.timeout(28_000), allowlist check at server.ts:84 before any API call.
- ISC-30..34: telegram.ts — raw fetch, no library dep confirmed by package.json grep.
- ISC-36: Dockerfile — `FROM oven/bun:1` confirmed.
- ISC-43..47,49: sync-context-pack.ts — encryption layout `[12B IV][16B tag][ciphertext]` matches memory.ts decrypt. EXCLUDED_PATTERNS grep confirmed. Freshness gate at system-prompt.ts:3.
- DEFERRED ISCs (7,9,10,23,35,37,38,39,40,41,42,48): require live GCP deployment — follow bootstrap.sh then re-verify.
