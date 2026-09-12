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

class EmbeddingPipeline {
  static instance: any = null;

  static async getInstance() {
    if (this.instance === null) {
      this.instance = await pipeline("feature-extraction", EMBED_MODEL);
    }
    return this.instance;
  }
}

export function getGroq() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured in .env.local");
  }
  // The SDK already retries 429s with exponential backoff and obeys the
  // retry-after header, so the budget is raised rather than reimplemented.
  // The free tier caps tokens per minute well before requests per minute, so
  // a burst of questions hits the limit long before the request count does.
  return new Groq({ apiKey, maxRetries: 3 });
}

/**
 * Turns a Groq failure into something worth showing a reader. Rate limiting is
 * the expected failure on the free tier, and "429" on its own tells them
 * nothing about what to do next.
 */
export function describeGroqError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 429) {
    return "Groq's free tier is rate limited right now. Wait a few seconds and ask again.";
  }
  if (status === 401 || status === 403) {
    return "Groq rejected the API key. Check GROQ_API_KEY.";
  }
  return (err as { message?: string })?.message || "Something went wrong generating the answer.";
}

export async function embedText(
  text: string,
  _taskType?: any
): Promise<number[]> {
  const extractor = await EmbeddingPipeline.getInstance();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const extractor = await EmbeddingPipeline.getInstance();
  const embeddings: number[][] = [];
  for (const t of texts) {
    const output = await extractor(t, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(output.data as Float32Array));
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
Cite every claim using [n] matching the context block numbers. If the context does not contain
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
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

