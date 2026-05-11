function apiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function sendMessage(chatId: number, text: string, token: string): Promise<void> {
  try {
    const res = await fetch(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[telegram] sendMessage failed ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error(`[telegram] sendMessage error: ${(err as Error).message}`);
  }
}

export async function setWebhook(url: string, token: string): Promise<void> {
  const res = await fetch(apiUrl(token, "setWebhook"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`setWebhook failed: ${data.description}`);
  console.log(`[telegram] webhook set to ${url}`);
}

export async function getWebhookInfo(token: string): Promise<{ url: string; pending_update_count: number }> {
  const res = await fetch(apiUrl(token, "getWebhookInfo"));
  const data = (await res.json()) as { ok: boolean; result: { url: string; pending_update_count: number } };
  if (!data.ok) throw new Error("getWebhookInfo failed");
  return data.result;
}
