import { YoutubeTranscript, YoutubeTranscriptNotAvailableLanguageError } from "youtube-transcript";
import { RawChunk } from "../chunking";

export function extractYoutubeId(url: string): string {
  // A YouTube source stores only its video id as raw_ref, and re-index passes
  // that back in here, so a bare id has to be accepted as well as a URL.
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  const match = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (!match) throw new Error("Could not parse YouTube video ID from URL");
  return match[1];
}

// Without a language the library takes the first caption track, which on a
// widely translated video can be any community translation. Kurzgesagt's
// "Optimistic Nihilism" came back in Albanian. Ask for English first and only
// fall back to the default track when the video has no English captions.
async function fetchPreferringEnglish(videoId: string) {
  try {
    return await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
  } catch (err) {
    if (err instanceof YoutubeTranscriptNotAvailableLanguageError) {
      return YoutubeTranscript.fetchTranscript(videoId);
    }
    throw err;
  }
}

// Groups raw transcript entries into ~30s windows so each chunk carries a
// tight timestamp range — this is what lets the source viewer jump to the
// exact moment a cited answer came from.
export async function extractYoutube(url: string): Promise<{ chunks: RawChunk[]; videoId: string }> {
  const videoId = extractYoutubeId(url);
  const entries = await fetchPreferringEnglish(videoId);

  const WINDOW_SECONDS = 30;
  const chunks: RawChunk[] = [];
  let windowText: string[] = [];
  let windowStart = entries[0]?.offset ?? 0;

  for (const e of entries) {
    if (e.offset - windowStart > WINDOW_SECONDS * 1000 && windowText.length) {
      chunks.push({
        content: windowText.join(" "),
        metadata: {
          timestamp_start: Math.floor(windowStart / 1000),
          timestamp_end: Math.floor(e.offset / 1000),
        },
      });
      windowText = [];
      windowStart = e.offset;
    }
    windowText.push(e.text);
  }
  if (windowText.length) {
    const last = entries[entries.length - 1];
    chunks.push({
      content: windowText.join(" "),
      metadata: {
        timestamp_start: Math.floor(windowStart / 1000),
        timestamp_end: Math.floor((last.offset + last.duration) / 1000),
      },
    });
  }

  return { chunks, videoId };
}
