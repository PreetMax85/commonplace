// Fallback transcript source for YouTube.
//
// YouTube serves caption tracks to residential addresses but refuses them to
// cloud ones, so the direct fetch that works in development always fails on
// the deployment. Supadata fetches the same published captions from its own
// infrastructure. It is only consulted when the direct attempt fails, and only
// when a key is configured, so local development keeps working without one.
//
// The free plan allows 100 transcripts a month, which is why adding a YouTube
// source carries its own site-wide daily limit.

const API = "https://api.supadata.ai/v1/transcript";
const JOB_POLL_MS = 3000;
const JOB_TIMEOUT_MS = 90_000;

export type TranscriptEntry = { text: string; offset: number; duration: number };

type SupadataContent = { text: string; offset: number; duration: number; lang?: string };
type SupadataResponse = { content?: SupadataContent[]; jobId?: string; status?: string; error?: string };

export function supadataConfigured(): boolean {
  return Boolean(process.env.SUPADATA_API_KEY);
}

async function call(url: string): Promise<{ status: number; body: SupadataResponse }> {
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.SUPADATA_API_KEY! },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as SupadataResponse;
  return { status: res.status, body };
}

// A long video is transcribed as a job rather than in the response, so the
// id that comes back is polled until it carries content.
async function awaitJob(jobId: string): Promise<SupadataContent[]> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    const { body } = await call(`${API}/${jobId}`);
    if (body.status === "completed" && body.content) return body.content;
    if (body.status === "failed") throw new Error("The transcript service could not read this video.");
  }
  throw new Error("The transcript service took too long to return this video.");
}

export async function fetchSupadataTranscript(videoId: string): Promise<TranscriptEntry[]> {
  const video = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  // mode=native keeps this to captions YouTube already publishes. The
  // alternative transcribes the audio, which costs two credits a minute.
  let { status, body } = await call(`${API}?url=${video}&lang=en&mode=native&text=false`);

  // A video with captions in another language only fails on the language ask,
  // so the default track is worth a second attempt, as with the direct fetch.
  if (status === 404 || status === 400) {
    ({ status, body } = await call(`${API}?url=${video}&mode=native&text=false`));
  }

  if (status === 206) throw new Error("This video has no transcript available.");
  if (status === 401 || status === 403) throw new Error("The transcript service rejected its API key.");
  if (status === 429) throw new Error("The transcript service is rate limited right now. Try again later.");

  const content = body.jobId ? await awaitJob(body.jobId) : body.content;
  if (!content?.length) {
    throw new Error(body.error || "The transcript service returned no transcript for this video.");
  }
  return content.map((c) => ({ text: c.text, offset: c.offset, duration: c.duration }));
}
