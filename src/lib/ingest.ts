import { supabaseAdmin } from "./supabase";
import { embedBatch } from "./gemini";
import { extractPdf } from "./extract/pdf";
import { extractPlainText } from "./extract/text";
import { extractUrl } from "./extract/url";
import { extractYoutube } from "./extract/youtube";
import { extractVtt } from "./extract/vtt";
import { RawChunk } from "./chunking";

export type SourceType = "pdf" | "text" | "url" | "youtube" | "vtt";

interface IngestInput {
  sourceId: string;
  notebookId: string;
  type: SourceType;
  // exactly one of these depending on type
  fileBuffer?: Buffer;
  rawText?: string;
  url?: string;
}

async function setStatus(sourceId: string, status: string, errorMessage?: string) {
  await supabaseAdmin
    .from("sources")
    .update({ status, error_message: errorMessage ?? null })
    .eq("id", sourceId);
}

export async function ingestSource(input: IngestInput) {
  const { sourceId, notebookId, type } = input;

  try {
    await setStatus(sourceId, "indexing");

    let chunks: RawChunk[] = [];
    let rawRef: string | undefined;

    switch (type) {
      case "pdf":
        if (!input.fileBuffer) throw new Error("Missing file buffer for PDF");
        chunks = await extractPdf(input.fileBuffer);
        break;
      case "text":
        if (!input.rawText) throw new Error("Missing text content");
        chunks = extractPlainText(input.rawText);
        // Store the raw text itself as raw_ref so re-index can run without
        // asking the user to re-paste it.
        rawRef = input.rawText;
        break;
      case "url": {
        if (!input.url) throw new Error("Missing URL");
        const result = await extractUrl(input.url);
        chunks = result.chunks;
        rawRef = input.url;
        break;
      }
      case "youtube": {
        if (!input.url) throw new Error("Missing YouTube URL");
        const result = await extractYoutube(input.url);
        chunks = result.chunks;
        rawRef = result.videoId;
        break;
      }
      case "vtt":
        if (!input.rawText) throw new Error("Missing VTT/SRT content");
        chunks = extractVtt(input.rawText);
        break;
      default:
        throw new Error(`Unsupported source type: ${type}`);
    }

    if (chunks.length === 0) {
      throw new Error("No extractable content found in source");
    }

    const embeddings = await embedBatch(chunks.map((c) => c.content));

    const rows = chunks.map((c, i) => ({
      source_id: sourceId,
      notebook_id: notebookId,
      content: c.content,
      metadata: c.metadata,
      embedding: embeddings[i],
    }));

    // Insert in batches of 100 to stay under payload limits.
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await supabaseAdmin.from("chunks").insert(batch);
      if (error) throw error;
    }

    const updates: Record<string, any> = { status: "ready" };
    // pdf/vtt already have raw_ref set to their storage path by the upload
    // route — don't clobber it here.
    if (rawRef !== undefined) updates.raw_ref = rawRef;
    await supabaseAdmin.from("sources").update(updates).eq("id", sourceId);
  } catch (err: any) {
    console.error(`Ingestion failed for source ${sourceId}:`, err);
    await setStatus(sourceId, "error", err.message ?? String(err));
  }
}

// Re-index every source type in place — no re-upload required:
// - url/youtube: re-fetch from the live URL/video (content may have changed)
// - pdf/vtt: re-download the original file from Storage, re-extract
// - text: re-chunk the raw text we saved as raw_ref on first ingest
export async function reindexSource(sourceId: string) {
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("id", sourceId)
    .single();
  if (error || !source) throw new Error("Source not found");

  // Wipe old chunks before re-ingesting.
  await supabaseAdmin.from("chunks").delete().eq("source_id", sourceId);

  switch (source.type as SourceType) {
    case "url":
    case "youtube":
      await ingestSource({
        sourceId: source.id,
        notebookId: source.notebook_id,
        type: source.type,
        url: source.raw_ref,
      });
      break;

    case "text":
      if (!source.raw_ref) throw new Error("Original text not found for this source");
      await ingestSource({
        sourceId: source.id,
        notebookId: source.notebook_id,
        type: "text",
        rawText: source.raw_ref,
      });
      break;

    case "pdf":
    case "vtt": {
      if (!source.raw_ref) throw new Error("Original file not found in storage for this source");
      const { data: fileData, error: downloadErr } = await supabaseAdmin.storage
        .from("sources")
        .download(source.raw_ref);
      if (downloadErr || !fileData) throw new Error("Could not download original file from storage");

      const buffer = Buffer.from(await fileData.arrayBuffer());
      await ingestSource({
        sourceId: source.id,
        notebookId: source.notebook_id,
        type: source.type,
        fileBuffer: source.type === "pdf" ? buffer : undefined,
        rawText: source.type === "vtt" ? buffer.toString("utf-8") : undefined,
      });
      break;
    }

    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }
}
