import Groq from "groq-sdk";
import { pipeline, env } from "@xenova/transformers";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configure Transformers.js for Node server environment. The default cache
// lives inside node_modules, which is read-only on serverless hosts, so the
// model download is pointed at the one writable directory available there.
env.allowLocalModels = false;
env.useBrowserCache = false;
env.cacheDir = join(tmpdir(), "transformers-cache");

// Groq shut down llama-3.3-70b-versatile on 2026-08-16. gpt-oss-120b is Groq's
// own recommended replacement; reasoning_effort stays low because answers are
// grounded in retrieved context, so long chains of thought only burn the free
// tier's tokens-per-minute budget and delay the first streamed token.
export const LLM_MODEL = "openai/gpt-oss-120b";
// Question rewriting is a short, mechanical task, so it runs on the small model
// to keep the answer call's share of the rate limit intact.
export const REWRITE_MODEL = "openai/gpt-oss-20b";
const EMBED_MODEL = "Xenova/bge-small-en-v1.5";

// pipeline() returns a union across every task it supports, so the
// feature-extraction shape is named here to keep the call sites typed.
type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array }>;

class EmbeddingPipeline {
  // The in-flight promise is cached, not the resolved pipeline, so two uploads
  // arriving together share one model download instead of racing to start two.
  static instance: Promise<FeatureExtractor> | null = null;

  static getInstance(): Promise<FeatureExtractor> {
    if (this.instance === null) {
      this.instance = (pipeline("feature-extraction", EMBED_MODEL) as Promise<FeatureExtractor>).catch(
        (err) => {
          // Caching the promise also caches a rejection. A single failed model
          // download would then break embedding for the life of the instance,
          // so the cache is cleared and the next request downloads again.
          this.instance = null;
          throw err;
        }
      );
    }
    return this.instance;
  }
}

export function getGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured in .env.local");
  }
  // The SDK already retries 429s with backoff and obeys retry-after, so retries
  // are configured rather than reimplemented. The budget is deliberately small:
  // retry-after on a rate-limited free tier can be tens of seconds, and the
  // caller is a person watching an empty chat bubble. One retry absorbs a brief
  // spike; past that, saying so beats making them wait in silence.
  return new Groq({ apiKey, maxRetries: 1 });
}

/**
 * Turns a Groq failure into something worth showing a reader. Rate limiting is
 * the expected failure on the free tier, and "429" on its own tells them
 * nothing about what to do next.
 */
export function describeGroqError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  const message = (err as { message?: string })?.message ?? "";
  // An error raised once the stream is already flowing carries no status at
  // all, so the message text is the only thing left to go on.
  if (status === 429 || /rate.?limit/i.test(message)) {
    return "Groq's free tier is rate limited right now. Wait a few seconds and ask again.";
  }
  if (status === 401 || status === 403) {
    return "Groq rejected the API key. Check GROQ_API_KEY.";
  }
  if (status === 400) {
    return "Groq could not complete this request. Try again with fewer sources.";
  }
  return message || "Something went wrong generating the answer.";
}

export async function embedText(text: string): Promise<number[]> {
  const extractor = await EmbeddingPipeline.getInstance();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const extractor = await EmbeddingPipeline.getInstance();
  const embeddings: number[][] = [];
  for (const t of texts) {
    const output = await extractor(t, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(output.data));
  }
  return embeddings;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export async function condenseQuestion(question: string, history: ChatTurn[]): Promise<string> {
  if (history.length === 0) return question;

  try {
    const groq = getGroq();
    const recent = history
      .slice(-6)
      .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
      .join("\n");

    const prompt = `Given this conversation, rewrite the final question as a standalone question
that makes sense without the conversation history. Preserve the original meaning exactly —
do not answer it, do not add information. Return ONLY the rewritten question, nothing else.

Conversation:
${recent}
User: ${question}

Standalone question:`;

    const response = await groq.chat.completions.create({
      model: REWRITE_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      reasoning_effort: "low",
      max_completion_tokens: 256,
    }, {
      // This call already falls back to the raw question on failure, so waiting
      // out a rate limit here would only delay the answer for no benefit.
      maxRetries: 0,
    });

    const rewritten = response.choices[0]?.message?.content?.trim();
    return rewritten || question;
  } catch (err) {
    console.warn("condenseQuestion failed, falling back to original question:", err);
    return question;
  }
}

export async function* streamAnswer(
  question: string,
  contextChunks: { content: string; metadata: any; source_id: string }[],
  history: ChatTurn[] = []
) {
  const groq = getGroq();

  const contextBlock = contextChunks
    .map(
      (c, i) =>
        `[${i + 1}] (source_id: ${c.source_id}, ${JSON.stringify(c.metadata)})\n${c.content}`
    )
    .join("\n\n---\n\n");

  const historyBlock = history.length
    ? "Conversation so far:\n" +
      history
        .slice(-6)
        .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
        .join("\n") +
      "\n\n"
    : "";

  const prompt = `You are a research assistant. Answer the question using ONLY the context below.
Cite every claim using [n] matching the context block numbers, written with plain ASCII square
brackets exactly like [1] and never as 【1】 or 【1†L1-L4】. If the context does not contain
the answer, say so explicitly — never make up information. Use the prior conversation only to
resolve references (like "it" or "that video") — never to answer from outside the context.
Format your answer in markdown: use **bold** for key terms, bullet or numbered lists for
multi-part answers, and short paragraphs. Keep citations attached to the specific claim they
support, not bundled at the end.

${historyBlock}Context:
${contextBlock}

Question: ${question}

Answer (markdown, with inline [n] citations):`;

  const stream = await groq.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    reasoning_effort: "low",
    // Keep the model's own reasoning out of the token stream. It is hidden by
    // default today, but the chat renders whatever arrives, so this is declared
    // rather than assumed.
    reasoning_format: "hidden",
    // Hidden reasoning still counts here. The cap keeps prompt plus answer under
    // the 8k tokens a minute even when the history is at its maximum.
    max_completion_tokens: 2000,
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

