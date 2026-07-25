import { GoogleGenerativeAI, TaskType } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const EMBED_MODEL = "gemini-embedding-001"; // text-embedding-004 was deprecated
const LLM_MODEL = "gemini-2.0-flash"; // fast + cheap, good for RAG answers

// gemini-embedding-001 outputs 3072 dims natively, but pgvector's ivfflat/hnsw
// indexes cap out at 2000 dims. The model is trained with Matryoshka
// Representation Learning, so truncating to the first N dims is a supported,
// quality-preserving operation (Google's own docs recommend 768/1536/3072) —
// this isn't a hack. 1536 keeps near-3072 retrieval quality while indexing.
const EMBED_DIM = 1536;

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

function isRateLimitError(err: any): boolean {
  const status = err?.status ?? err?.response?.status;
  const message = String(err?.message ?? "");
  return status === 429 || message.includes("429") || message.toLowerCase().includes("quota");
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Retries with exponential backoff + jitter on 429/quota errors specifically —
// other errors (bad input, auth) fail fast instead of masking a real bug.
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRateLimitError(err) || attempt === MAX_RETRIES) throw err;
      const delay = BASE_DELAY_MS * 2 ** attempt + Math.random() * 300;
      console.warn(`${label}: rate limited, retrying in ${Math.round(delay)}ms (attempt ${attempt + 1})`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Truncates to EMBED_DIM then L2-normalizes. gemini-embedding-001 only
// auto-normalizes the full 3072-dim output — after truncating ourselves
// (the @google/generative-ai SDK doesn't expose outputDimensionality),
// re-normalizing is required or cosine similarity via pgvector skews.
function truncateAndNormalize(values: number[]): number[] {
  const truncated = values.slice(0, EMBED_DIM);
  const magnitude = Math.sqrt(truncated.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return truncated;
  return truncated.map((v) => v / magnitude);
}

export async function embedText(
  text: string,
  taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT
): Promise<number[]> {
  return withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: EMBED_MODEL });
    const result = await model.embedContent({
      content: { role: "user", parts: [{ text }] },
      taskType,
    });
    return truncateAndNormalize(result.embedding.values);
  }, "embedText");
}

// Batch embed with rate-limit-aware retry per item. A single chunk that
// keeps failing after MAX_RETRIES throws — the caller (ingest.ts) marks
// the whole source as errored rather than silently storing partial data.
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) {
    out.push(await embedText(t, TaskType.RETRIEVAL_DOCUMENT));
    await sleep(50);
  }
  return out;
}

export function getLLM() {
  return genAI.getGenerativeModel({ model: LLM_MODEL });
}

// Rewrites a follow-up ("what about part 2?") into a standalone question
// using the recent conversation, so retrieval embeds something searchable
// instead of a bare pronoun. No-op (returns the question unchanged) when
// there's no history yet, or if the rewrite call itself fails.
export async function condenseQuestion(question: string, history: ChatTurn[]): Promise<string> {
  if (history.length === 0) return question;

  try {
    const model = getLLM();
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

    const result = await withRetry(() => model.generateContent(prompt), "condenseQuestion");
    const rewritten = result.response.text().trim();
    return rewritten || question;
  } catch {
    return question; // never block the query on a rewrite failure
  }
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

// Streaming grounded answer generation. Accepts prior turns so follow-up
// questions ("what about X instead?") resolve correctly — retrieval itself
// still runs on the latest question only (the route decides that), but the
// LLM sees the conversation so it can track pronouns/references across turns.
export async function* streamAnswer(
  question: string,
  contextChunks: { content: string; metadata: any; source_id: string }[],
  history: ChatTurn[] = []
) {
  const model = getLLM();

  const contextBlock = contextChunks
    .map(
      (c, i) =>
        `[${i + 1}] (source_id: ${c.source_id}, ${JSON.stringify(c.metadata)})\n${c.content}`
    )
    .join("\n\n---\n\n");

  const historyBlock = history.length
    ? "Conversation so far:\n" +
      history
        .slice(-6) // last 3 exchanges is plenty of context, keeps prompt small
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

  // Only the stream-start call is retried (rate limits show up here, before
  // any tokens land) — once tokens are flowing we let a mid-stream failure
  // surface as-is rather than silently restarting a partial answer.
  const result = await withRetry(() => model.generateContentStream(prompt), "streamAnswer");

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}
