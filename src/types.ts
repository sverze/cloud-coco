export interface ContextPack {
  version: string;
  generated: string;
  identity: {
    name: string;
    timezone: string;
    communication_style: string;
  };
  active_goals: string[];
  preferences: Record<string, string>;
  recent_summary: string;
  last_sync: string;
}

// Temporal context stamped on every new longitudinal entry.
// Optional so existing entries without these fields remain valid.
export interface TemporalMeta {
  week: string;             // ISO 8601 week — "2026-W20"
  quarter: string;          // "2026-Q2"
  goals_snapshot: string[]; // active_goals from context pack at write time
  context_pack_ref: string; // context pack's generated timestamp
}

export interface ConversationEntry extends Partial<TemporalMeta> {
  ts: string;
  role: "user" | "assistant";
  content: string;
  topic?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  };
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface AppSecrets {
  claudeApiKey: string;
  telegramToken: string;
  contextPackKey: Buffer;
  allowedChatIds: Set<number>;
  webhookSecret: string;
  relayUrl: string | undefined;
  relayBearerToken: string | undefined;
  mcpBearerToken: string | undefined;
}

export interface NoteEntry extends Partial<TemporalMeta> {
  ts: string;
  content: string;
  tags?: string[];
  topic?: string;
  source: "claude-code";
}

export interface DecisionEntry extends Partial<TemporalMeta> {
  ts: string;
  title: string;
  rationale: string;
  context?: string;
  project?: string;
  source: "claude-code";
}

export interface LearningEntry extends Partial<TemporalMeta> {
  ts: string;
  insight: string;
  source_note?: string;
  project?: string;
  source: "claude-code";
}
