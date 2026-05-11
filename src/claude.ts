import Anthropic from "@anthropic-ai/sdk";

const FALLBACK = "Sorry, I ran into an issue. Try again in a moment.";
const TIMEOUT_MS = 28_000;

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      },
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    const block = response.content[0];
    if (block.type !== "text") return FALLBACK;
    return block.text;
  } catch (err) {
    console.error(`[claude] error: ${(err as Error).message}`);
    return FALLBACK;
  }
}
