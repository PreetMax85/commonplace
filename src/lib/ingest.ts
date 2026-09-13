import { supabaseAdmin } from "./supabase";
import { embedBatch } from "./llm";
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
    .update({
      status,
      error_message: errorMessage ?? null,
      // Stamped on every transition so a source that stops progressing can be
      // told apart from one that is simply slow.
      updated_at: new Date().toISOString(),
    })
    .eq("id", sourceId);
}

export async function ingestSource(input: IngestInput, { replacing = false }: { replacing?: boolean } = {}) {
  const { sourceId, notebookId, type } = input;
  // A re-index writes the new chunks next to the old ones and removes the old
  // ones only once every new batch is in, so a failed re-index leaves the
  // source searchable as it was instead of empty. For a moment both sets are
  // live and a query can see a passage twice, which is the cheaper failure.
  let previousIds: string[] = [];
  // What this run has written, so a failure removes its own work and nothing else.
  const insertedIds: string[] = [];

  try {
    await setStatus(sourceId, "indexing");
    if (replacing) previousIds = await chunkIdsFor(sourceId);

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
      // Reading order within the source. Nothing in metadata can play this
      // role: chunk_index restarts on every PDF page, and the transcript
      // extractors never set it at all.
      ordinal: i,
      embedding: embeddings[i],
    }));

    // Insert in batches of 100 to stay under payload limits.
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { data: inserted, error } = await supabaseAdmin.from("chunks").insert(batch).select("id");
      if (error) throw error;
      insertedIds.push(...inserted.map((row) => row.id));
    }

    await deleteChunks(previousIds);

    const updates: Record<string, any> = {
      status: "ready",
      error_message: null,
      updated_at: new Date().toISOString(),
    };
    // pdf/vtt already have raw_ref set to their storage path by the upload
    // route — don't clobber it here.
    if (rawRef !== undefined) updates.raw_ref = rawRef;
    await supabaseAdmin.from("sources").update(updates).eq("id", sourceId);
  } catch (err: any) {
    console.error(`Ingestion failed for source ${sourceId}:`, err);
    // Record the failure first. Cleanup talks to the same database that just
    // failed, so doing it first risks throwing again and leaving the source
    // stuck on "indexing" with nothing to explain it.
    await recordFailure(sourceId, err.message ?? String(err), previousIds.length > 0);

    // Chunks go in a batch at a time, so a failure partway through leaves
    // earlier batches behind, still searchable and citable next to whatever
    // the source held before.
    try {
      await deleteChunks(insertedIds);
    } catch (cleanupError) {
      console.error(`Chunk cleanup failed for source ${sourceId}:`, cleanupError);
    }
  }
}

// A failed re-index of a source that still has its previous chunks remains
// usable, so it reads as ready with a note rather than as broken.
export async function recordFailure(sourceId: string, message: string, keptPreviousVersion: boolean) {
  if (!keptPreviousVersion) {
    await setStatus(sourceId, "error", message);
    return;
  }
  await supabaseAdmin
    .from("sources")
    .update({
      status: "ready",
      error_message: `Re-index failed, so the previous version is still in use: ${message}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sourceId);
}

// Pages through the ids, since a select returns at most 1000 rows by default
// and a long document can run past that.
async function chunkIdsFor(sourceId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("chunks")
      .select("id")
      .eq("source_id", sourceId)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    ids.push(...data.map((row) => row.id));
    if (data.length < 1000) return ids;
  }
}

// Deletes in batches, since hundreds of ids in one filter would run past URL
// length limits on the REST API.
async function deleteChunks(ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await supabaseAdmin.from("chunks").delete().in("id", ids.slice(i, i + 100));
    if (error) throw error;
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

  switch (source.type as SourceType) {
    case "url":
    case "youtube":
      await ingestSource({
        sourceId: source.id,
        notebookId: source.notebook_id,
        type: source.type,
        url: source.raw_ref,
      }, { replacing: true });
      break;

    case "text":
      if (!source.raw_ref) throw new Error("Original text not found for this source");
      await ingestSource({
        sourceId: source.id,
        notebookId: source.notebook_id,
        type: "text",
        rawText: source.raw_ref,
      }, { replacing: true });
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
      }, { replacing: true });
      break;
    }

    default:
      throw new Error(`Unsupported source type: ${source.type}`);
  }
}
