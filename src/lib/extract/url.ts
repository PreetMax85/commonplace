import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chunkText, RawChunk } from "../chunking";

// Covers the whole download, not only the wait for the first byte, so a site
// that answers and then trickles its page still gives up in time. Without it a
// stuck site held the function until the platform killed it, leaving the
// source on "indexing" with nothing to explain it.
const FETCH_TIMEOUT_MS = 15_000;

export async function extractUrl(url: string): Promise<{ chunks: RawChunk[]; title: string }> {
  const html = await fetchPage(url);

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) throw new Error("Could not extract readable content from page");

  const title = article.title || url;
  const chunks = chunkText(article.textContent ?? "", { url, section: title });
  return { chunks, title };
}

async function fetchPage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`That page took too long to load (over ${FETCH_TIMEOUT_MS / 1000} seconds).`);
    }
    throw err;
  }
}
