import { config } from "./config.js";
import type { Finding } from "./detectors/types.js";

const SYSTEM = `You are a security analyst agent in Leukonet, a swarm that protects NEAR users from scams.
Write ONE plain-English sentence (max 220 characters) telling an ordinary wallet user what this account did and why they should not send it money.
No jargon, no hedging, no markdown. Mention the concrete numbers.`;

/**
 * Explains a finding with an LLM on NEAR AI Cloud. Falls back to the
 * detector's own reason when no API key is set or the call fails.
 */
export async function explain(f: Finding): Promise<{ text: string; source: "near-ai" | "template" }> {
  if (!config.nearAiKey) return { text: f.reason, source: "template" };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`${config.nearAiUrl}/chat/completions`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.nearAiKey}` },
      body: JSON.stringify({
        model: config.nearAiModel,
        max_tokens: 120,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: JSON.stringify({ account: f.target, category: f.category, detector_reason: f.reason, evidence: f.evidence }),
          },
        ],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`NEAR AI ${res.status}`);
    const body: any = await res.json();
    const text = String(body.choices?.[0]?.message?.content ?? "").trim().replace(/\s+/g, " ");
    if (!text) throw new Error("empty completion");
    return { text: text.slice(0, 380), source: "near-ai" };
  } catch {
    return { text: f.reason, source: "template" };
  }
}
