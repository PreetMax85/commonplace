import Groq from "groq-sdk";
import { pipeline, env } from "@xenova/transformers";

// Configure Transformers.js for Node server environment
env.allowLocalModels = false;
env.useBrowserCache = false;

export const LLM_MODEL = "llama-3.3-70b-versatile";
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
  return new Groq({ apiKey });
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
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 256,
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

${historyBlock}Context:
${contextBlock}

Question: ${question}

Answer (with inline [n] citations):`;

  const stream = await groq.chat.completions.create({
    model: LLM_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

