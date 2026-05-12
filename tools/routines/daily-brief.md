# Cloud Coco — Daily Brief Routine

A Claude Code Routine that runs every morning, refreshes the context pack from GCS, and pushes a focused daily brief to Telegram.

## What it does

1. Calls `refresh_context_pack` to reload the latest encrypted identity snapshot from GCS
2. Calls `get_daily_brief` for today's goals, recent notes, and recent decisions
3. Calls `get_recent_learnings` for the last 3 captured insights
4. Synthesises a concise morning brief (no fluff, just signal)
5. Calls `send_telegram_message` to push it

Runs on Anthropic cloud — no MacBook required. The context pack on GCS is refreshed separately by the local `bun sync` launchd job (see below).

---

## Routine prompt

```
You are helping me start my day with focus and clarity. Be concise — no preamble.

1. Call refresh_context_pack to ensure the context is current.
2. Call get_daily_brief.
3. Call get_recent_learnings with limit 3.
4. Compose a morning brief with exactly this structure:

   📅 [Day, Date]

   🎯 Focus
   [The single most important goal or task right now — one sentence]

   ✅ Active goals
   [2-4 bullet points, goal titles only]

   🧠 Recent signal
   [1-2 of the most relevant recent notes or learnings — one line each]

   ⚡ Carry forward
   [Any open decision or blocker worth keeping in mind today — one line, or omit if none]

5. Call send_telegram_message with the brief.
```

---

## Setup (one-time)

### Step 1 — Ensure cloud-coco MCP is connected

```bash
claude mcp list
# cloud-coco: https://cloud-coco-747929980753.us-central1.run.app/mcp (connected)
```

If not connected, see the main README Setup §9.

### Step 2 — Create the Routine via CLI

```bash
# In a Claude Code session, type:
/schedule
```

Claude will guide you through:
- **Name:** `cloud-coco-daily-brief`
- **Schedule:** Daily at 07:00 America/Los_Angeles
- **Prompt:** paste the prompt from above
- **MCP connectors:** add `cloud-coco`
- **Repositories:** none required

Or create it directly at [claude.ai/code/routines](https://claude.ai/code/routines).

### Step 3 — Automate context pack generation (MacBook side)

The Routine reads from GCS, but `bun sync` needs to run locally to push fresh PAI memory first.

Install the launchd job that runs `bun sync` daily at 06:45 (15 min before the Routine fires):

```bash
# Edit paths in the plist if your bun or project location differs
cat > ~/Library/LaunchAgents/com.cloud-coco.sync.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cloud-coco.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>cd /Users/stevenverze/dev/projects/sverze/cloud-coco && /Users/stevenverze/.bun/bin/bun sync >> /tmp/cloud-coco-sync.log 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>45</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/cloud-coco-sync.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/cloud-coco-sync.error.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.cloud-coco.sync.plist

# Verify it's loaded
launchctl list | grep cloud-coco
```

**When MacBook is offline:** The Routine still fires on Anthropic cloud. `refresh_context_pack` reads whatever is in GCS — if `bun sync` didn't run that morning (MacBook asleep), it uses the last uploaded pack. The brief will note the pack age if it's stale.

---

## Flow diagram

```
06:45 MacBook (if awake)          07:00 Anthropic cloud (always)
──────────────────────            ─────────────────────────────────
launchd: bun sync                 Routine fires
  → reads PAI memory files        → calls refresh_context_pack (MCP)
  → generates context pack          → Cloud Run reloads from GCS
  → encrypts AES-256-GCM          → calls get_daily_brief (MCP)
  → uploads to GCS                → calls get_recent_learnings (MCP)
                                  → synthesises brief
                                  → calls send_telegram_message (MCP)
                                      → Telegram push to phone
```

---

## Verify the Routine works

After setup, trigger it manually from the web UI or wait for the first scheduled run. You should receive a Telegram message like:

```
📅 Tuesday, 13 May

🎯 Focus
Ship the temporal schema redesign and get it deployed

✅ Active goals
- Evolve Coco into a fully integrated personal assistant
- Build an agentic-enabled PDLC for enterprise engineering

🧠 Recent signal
- Council debate concluded: longitudinal coherence is the product
- OAuth PKCE flow live — all surfaces connected

⚡ Carry forward
Baron's point: verify relay is not load-bearing before next deploy
```
