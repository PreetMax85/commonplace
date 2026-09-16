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

import type { TranscriptEntry } from "../chunking";

const API = "https://api.supadata.ai/v1/transcript";
// Job status costs nothing to check, and the provider recommends every second.
const JOB_POLL_MS = 1000;
// Well inside the route's 300s budget and the sweep that fails a stalled
// source after 10 minutes, with room for a long lecture to finish.
const JOB_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 30_000;

type SupadataContent = { text: string; offset: number; duration: number; lang?: string };
type SupadataResponse = {
  content?: SupadataContent[];
  lang?: string;
  availableLangs?: string[];
  jobId?: string;
  status?: string;
  error?: string;
  message?: string;
  details?: string;
};

export function supadataConfigured(): boolean {
  return Boolean(process.env.SUPADATA_API_KEY);
}

function isEnglish(lang?: string): boolean {
  return Boolean(lang && /^en(-|$)/i.test(lang));
}

async function call(url: string): Promise<{ status: number; body: SupadataResponse }> {
  const res = await fetch(url, {
    headers: { "x-api-key": process.env.SUPADATA_API_KEY! },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as SupadataResponse;
  return { status: res.status, body };
}

// The provider's own words are written for a person and name the real problem,
// so they are preferred over a generic sentence. The machine-readable code
// stays in the logs.
function describe(status: number, body: SupadataResponse): string {
  if (status === 206) return "This video has no transcript available.";
  if (status === 401) return "The transcript service rejected its API key.";
  if (status === 402) return "The transcript service plan does not cover this request.";
  if (status === 403 || status === 404) return "This video is private, restricted or unavailable.";
  if (status === 429) return "The transcript service is rate limited right now. Try again later.";
  return body.message || "The transcript service could not read this video.";
}

// A long video is transcribed as a job rather than in the response, so the id
// that comes back is polled until it carries content. The 202 has already cost
// a credit at this point, so a single failed poll is retried rather than
// thrown away; only a real failure or the deadline ends the wait.
async function awaitJob(jobId: string): Promise<SupadataContent[]> {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastError = "The transcript service took too long to return this video.";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    try {
      const { status, body } = await call(`${API}/${encodeURIComponent(jobId)}`);
      if (status === 200 && body.status === "completed" && body.content) return body.content;
      if (status === 200 && body.status === "failed") {
        throw new Error(describe(status, body));
      }
      // A status the job cannot recover from, rather than a blip worth retrying.
      if (status !== 200 && status !== 202 && status !== 429 && status < 500) {
        throw new Error(describe(status, body));
      }
      if (status !== 200) lastError = describe(status, body);
    } catch (err) {
      if (err instanceof Error && !err.name.includes("TimeoutError")) throw err;
      // A timed-out or dropped poll says nothing about the job; try again.
    }
  }
  throw new Error(lastError);
}

export async function fetchSupadataTranscript(videoId: string): Promise<TranscriptEntry[]> {
  const video = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`);
  // mode=native keeps this to captions YouTube already publishes. The
  // alternative transcribes the audio, which costs two credits a minute.
  const query = (lang?: string) =>
    `${API}?url=${video}&mode=native&text=false${lang ? `&lang=${lang}` : ""}`;

  let { status, body } = await call(query("en"));
  if (status !== 200 && status !== 202) {
    console.error(`Supadata rejected ${videoId}:`, status, body.error, body.details ?? "");
    throw new Error(describe(status, body));
  }

  // Asking for English never fails: an English-less video comes back in
  // whatever track is first, which is how a Kurzgesagt video was once indexed
  // in Albanian. The direct fetch prefers English for the same reason, so when
  // the answer is not English and an English track exists, ask for it by name.
  if (status === 200 && !isEnglish(body.lang)) {
    const english = body.availableLangs?.find(isEnglish);
    if (english) {
      const retry = await call(query(english));
      if (retry.status === 200 || retry.status === 202) ({ status, body } = retry);
    } else {
      console.warn(`Supadata returned ${videoId} in ${body.lang}; no English track available.`);
    }
  }

  const content = body.jobId ? await awaitJob(body.jobId) : body.content;
  if (!content?.length) throw new Error(describe(status, body));
  return content.map((c) => ({ text: c.text, offset: c.offset, duration: c.duration }));
}
