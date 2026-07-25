import { RawChunk } from "../chunking";

interface Cue {
  start: number;
  end: number;
  text: string;
}

function timeToSeconds(t: string): number {
  // Handles both "00:00:01.000" (vtt) and "00:00:01,000" (srt)
  const norm = t.replace(",", ".");
  const [h, m, s] = norm.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function parseCues(raw: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = raw.replace(/^WEBVTT.*\n/, "").split(/\n\s*\n/);

  for (const block of blocks) {
    const timeMatch = block.match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
    );
    if (!timeMatch) continue;
    const text = block
      .split("\n")
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()))
      .join(" ")
      .trim();
    if (!text) continue;
    cues.push({
      start: timeToSeconds(timeMatch[1]),
      end: timeToSeconds(timeMatch[2]),
      text,
    });
  }
  return cues;
}

// Groups cues into ~30s windows, same strategy as the YouTube extractor,
// so transcript-based sources cite consistently regardless of origin.
export function extractVtt(raw: string): RawChunk[] {
  const cues = parseCues(raw);
  const WINDOW_SECONDS = 30;
  const chunks: RawChunk[] = [];
  let windowText: string[] = [];
  let windowStart = cues[0]?.start ?? 0;

  for (const cue of cues) {
    if (cue.start - windowStart > WINDOW_SECONDS && windowText.length) {
      chunks.push({
        content: windowText.join(" "),
        metadata: { timestamp_start: windowStart, timestamp_end: cue.start },
      });
      windowText = [];
      windowStart = cue.start;
    }
    windowText.push(cue.text);
  }
  if (windowText.length) {
    const last = cues[cues.length - 1];
    chunks.push({
      content: windowText.join(" "),
      metadata: { timestamp_start: windowStart, timestamp_end: last.end },
    });
  }

  return chunks;
}
