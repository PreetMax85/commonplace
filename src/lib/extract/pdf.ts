import { chunkText, RawChunk } from "../chunking";

// pdf-parse v2 exports a PDFParse class (the old v1 callback-style function
// API is gone). getText() returns per-page text directly, which is exactly
// what we need to attach a `page` number to each chunk's metadata.
export async function extractPdf(buffer: Buffer): Promise<RawChunk[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    const chunks: RawChunk[] = [];
    for (const page of result.pages) {
      chunks.push(...chunkText(page.text, { page: page.num }));
    }
    return chunks;
  } finally {
    await parser.destroy();
  }
}
