import { lookup } from "node:dns/promises";
import { BlockList } from "node:net";
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
const MAX_REDIRECTS = 5;

// The server fetches whatever link a visitor gives it and shows them the
// text, so a link must not reach addresses only the server can: its own
// machine, a private network, or a cloud metadata service. IPv4 rules also
// match the same address written in IPv6's mapped form (::ffff:127.0.0.1).
// ::/96 covers ::1 and the older IPv4-compatible form (::127.0.0.1).
const privateRanges = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) {
  privateRanges.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  privateRanges.addSubnet(address, prefix, "ipv6");
}

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

// Redirects are followed by hand so every hop is checked: a public page can
// redirect to a private address. The check and the fetch each look the name
// up, so a DNS server that answers differently the second time can still get
// past it. Closing that needs control over the connection itself, which is
// more than a notebook app's link fetcher warrants.
async function fetchPage(url: string): Promise<string> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    let current = new URL(url);
    for (let redirects = 0; ; redirects++) {
      await checkPublic(current);
      const res = await fetch(current, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "manual",
        signal,
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        if (redirects === MAX_REDIRECTS) throw new Error("That link redirects too many times.");
        try {
          current = new URL(location, current);
        } catch {
          throw new Error("That link redirects to an address that is not valid.");
        }
        continue;
      }
      try {
        if (!res.ok) throw new Error(statusMessage(res.status));
        checkContentType(res.headers.get("content-type"));
      } catch (err) {
        // Nothing more will be read, so the connection is freed now rather
        // than left open until the timer fires.
        await res.body?.cancel();
        throw err;
      }
      return await readLimited(res);
    }
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`That page took too long to load (over ${FETCH_TIMEOUT_MS / 1000} seconds).`);
    }
    // fetch reports every network failure (refused, reset, bad certificate)
    // with this one message, and the detail means nothing to a visitor.
    if (err instanceof TypeError && err.message === "fetch failed") {
      throw new Error("Could not connect to that site.");
    }
    throw err;
  }
}

// These reach the visitor as the reason the source failed. Many sites refuse
// automated readers outright, and pasting the text is the way around that.
function statusMessage(status: number): string {
  if (status === 404 || status === 410) return `That page does not exist (status ${status}).`;
  if (status === 401 || status === 403 || status === 429) {
    return `That site refused the request (status ${status}). Some sites block automated reading, so try pasting the text instead.`;
  }
  return `That site answered with an error (status ${status}).`;
}

async function checkPublic(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links can be added.");
  }
  // An IPv6 address keeps its brackets in the hostname.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`Could not find the site ${host}.`);
  }
  const blocked = addresses.some(({ address, family }) => {
    try {
      return privateRanges.check(address, family === 6 ? "ipv6" : "ipv4");
    } catch {
      return true; // an address the check cannot read is not let through
    }
  });
  if (blocked) throw new Error("That link points to a private network address, so it cannot be added.");
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
