import type { AppSecrets } from "./types.ts";

// On Cloud Run, K_SERVICE is always set.
const ON_CLOUD_RUN = Boolean(process.env.K_SERVICE);

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error(`Metadata token fetch failed: ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

async function getProjectId(): Promise<string> {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/project/project-id",
    { headers: { "Metadata-Flavor": "Google" } }
  );
  if (!res.ok) throw new Error(`Metadata project-id fetch failed: ${res.status}`);
  return res.text();
}

async function getSecret(name: string, projectId: string, token: string): Promise<string> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${name}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Secret Manager fetch failed for ${name}: ${res.status}`);
  const data = (await res.json()) as { payload: { data: string } };
  return Buffer.from(data.payload.data, "base64").toString("utf8");
}

async function loadFromCloudRun(): Promise<AppSecrets> {
  const [projectId, token] = await Promise.all([getProjectId(), getAccessToken()]);
  const [claudeApiKey, telegramToken, contextPackKeyHex, allowedChatIdsStr] = await Promise.all([
    getSecret("CLAUDE_API_KEY", projectId, token),
    getSecret("TELEGRAM_BOT_TOKEN", projectId, token),
    getSecret("CONTEXT_PACK_KEY", projectId, token),
    getSecret("ALLOWED_CHAT_IDS", projectId, token),
  ]);
  return buildSecrets(claudeApiKey, telegramToken, contextPackKeyHex, allowedChatIdsStr);
}

function loadFromEnv(): AppSecrets {
  const claudeApiKey = process.env.CLAUDE_API_KEY;
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const contextPackKeyHex = process.env.CONTEXT_PACK_KEY;
  const allowedChatIdsStr = process.env.ALLOWED_CHAT_IDS;

  if (!claudeApiKey) throw new Error("CLAUDE_API_KEY env var is required");
  if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN env var is required");
  if (!contextPackKeyHex) throw new Error("CONTEXT_PACK_KEY env var is required");
  if (!allowedChatIdsStr) throw new Error("ALLOWED_CHAT_IDS env var is required");

  return buildSecrets(claudeApiKey, telegramToken, contextPackKeyHex, allowedChatIdsStr);
}

function buildSecrets(
  claudeApiKey: string,
  telegramToken: string,
  contextPackKeyHex: string,
  allowedChatIdsStr: string
): AppSecrets {
  const trimmedKey = contextPackKeyHex.trim();
  if (trimmedKey.length !== 64) {
    throw new Error(`CONTEXT_PACK_KEY must be 64 hex chars, got ${trimmedKey.length}`);
  }
  const contextPackKey = Buffer.from(trimmedKey, "hex");
  const allowedChatIds = new Set(
    allowedChatIdsStr.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
  );
  return { claudeApiKey, telegramToken, contextPackKey, allowedChatIds };
}

export async function loadSecrets(): Promise<AppSecrets> {
  if (ON_CLOUD_RUN) {
    console.log("[secrets] loading from GCP Secret Manager");
    return loadFromCloudRun();
  }
  console.log("[secrets] loading from environment variables");
  return loadFromEnv();
}
