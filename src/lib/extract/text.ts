import { chunkText, RawChunk } from "../chunking";

export function extractPlainText(text: string): RawChunk[] {
  return chunkText(text, { kind: "text" });
}
