import { getDocumentProxy, extractText } from "unpdf";
import { chunkText, RawChunk } from "../chunking";

export async function extractPdf(buffer: Buffer): Promise<RawChunk[]> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  const chunks: RawChunk[] = [];
  const textPages = Array.isArray(text) ? text : [text];

  for (let i = 0; i < textPages.length; i++) {
    const pageText = textPages[i];
    if (pageText && pageText.trim().length > 0) {
      chunks.push(...chunkText(pageText, { page: i + 1 }));
    }
  }

  return chunks;
}


