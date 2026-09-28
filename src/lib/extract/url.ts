import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chunkText, RawChunk } from "../chunking";

// Covers the whole download, not only the wait for the first byte, so a site
// that answers and then trickles its page still gives up in time. Without it a
// stuck site held the function until the platform killed it, leaving the
// source on "indexing" with nothing to explain it.
const FETCH_TIMEOUT_MS = 15_000;
// Far above any article (a long one is a few hundred KB of HTML), and the
// page is held in memory whole, so a link to a huge file must stop here.
const MAX_PAGE_BYTES = 5 * 1024 * 1024;

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
    checkContentType(res.headers.get("content-type"));
    return await readLimited(res);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`That page took too long to load (over ${FETCH_TIMEOUT_MS / 1000} seconds).`);
    }
    throw err;
  }
}

// A missing type is let through, since some servers leave it out on real
// pages. Plain text reads fine as a page body, so it is let through as well.
function checkContentType(header: string | null) {
  const type = header?.split(";")[0].trim().toLowerCase();
  if (!type || type === "text/html" || type === "application/xhtml+xml" || type === "text/plain") return;
  if (type === "application/pdf") {
    throw new Error("That link is a PDF, not a web page. Download it and add it as a PDF instead.");
  }
  throw new Error(`That link is not a web page (it is ${type}).`);
}

// Reads the body a piece at a time and stops at the limit, so an oversized
// page is never held whole. The declared length is checked first to refuse
// an honest oversized answer without reading any of it.
async function readLimited(res: Response): Promise<string> {
  const tooLarge = () => new Error(`That page is too large (over ${MAX_PAGE_BYTES / 1024 / 1024} MB).`);
  if (Number(res.headers.get("content-length")) > MAX_PAGE_BYTES) {
    await res.body?.cancel();
    throw tooLarge();
  }
  if (!res.body) return "";

  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}
