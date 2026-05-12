import Anthropic from "@anthropic-ai/sdk";

const FALLBACK = "Sorry, I ran into an issue. Try again in a moment.";
const TIMEOUT_MS = 55_000;

// Anthropic's managed web search — executed server-side, no client search API needed
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search" } as unknown as Anthropic.Tool;

export async function askClaude(
  systemPrompt: string,
  userMessage: string,
  apiKey: string
): Promise<string> {
  const client = new Anthropic({ apiKey });
  try {
    const response = await client.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        tools: [WEB_SEARCH_TOOL],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );

    // Response may include tool_use/tool_result blocks alongside text — extract text only
    const text = response.content
      .filter(b => b.type === "text")
      .map(b => (b as Anthropic.Messages.TextBlock).text)
      .join("\n\n");

    return text || FALLBACK;
  } catch (err) {
    console.error(`[claude] error: ${(err as Error).message}`);
    return FALLBACK;
  }
}
