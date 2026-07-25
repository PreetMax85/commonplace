import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chunkText, RawChunk } from "../chunking";

export async function extractUrl(url: string): Promise<{ chunks: RawChunk[]; title: string }> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) throw new Error("Could not extract readable content from page");

  const title = article.title || url;
  const chunks = chunkText(article.textContent ?? "", { url, section: title });
  return { chunks, title };
}
