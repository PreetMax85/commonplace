export interface RawChunk {
  content: string;
  metadata: Record<string, any>;
}

/**
 * Recursive-ish character splitter with overlap. Keeps whatever metadata
 * (page number, timestamp range, section heading) the caller attaches per
 * text segment, so chunk boundaries never lose their source anchor.
 */
export function chunkText(
  text: string,
  metadata: Record<string, any> = {},
  { chunkSize = 1000, overlap = 150 }: { chunkSize?: number; overlap?: number } = {}
): RawChunk[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const chunks: RawChunk[] = [];
  let start = 0;
  let idx = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    // Try to break on sentence boundary near the end.
    if (end < clean.length) {
      const lastPeriod = clean.lastIndexOf(". ", end);
      if (lastPeriod > start + chunkSize * 0.5) end = lastPeriod + 1;
    }
    chunks.push({
      content: clean.slice(start, end).trim(),
      metadata: { ...metadata, chunk_index: idx },
    });
    idx++;
    start = end - overlap;
    if (start < 0) start = 0;
    if (end === clean.length) break;
  }

  return chunks;
}
