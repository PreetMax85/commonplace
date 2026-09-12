import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { ingestSource, SourceType } from "@/lib/ingest";

// Embedding a long PDF runs well past a default request, and after() inherits
// this budget.
export const maxDuration = 300;

// A function that dies mid-ingest, most likely by exhausting maxDuration on a
// very long document, takes its error handling down with it and leaves the
// source reading "indexing" forever. There is no background worker on this
// stack to notice, and this poll is the only thing that runs regularly, so the
// sweep lives here. The window is generously past maxDuration so that a merely
// slow ingest is never mistaken for a dead one.
const STALE_INDEXING_MS = 10 * 60 * 1000;

async function failStalledSources(notebookId: string) {
  const cutoff = new Date(Date.now() - STALE_INDEXING_MS).toISOString();
  const { error } = await supabaseAdmin
    .from("sources")
    .update({
      status: "error",
      error_message: "Indexing stopped unexpectedly. Re-index to try again.",
      updated_at: new Date().toISOString(),
    })
    .eq("notebook_id", notebookId)
    .in("status", ["uploading", "indexing"])
    .lt("updated_at", cutoff);
  if (error) console.error(`Stalled source sweep failed for notebook ${notebookId}:`, error);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await failStalledSources(id);
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("notebook_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// Accepts multipart/form-data for pdf uploads, JSON for text/url/youtube/vtt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: notebookId } = await params;
  const contentType = req.headers.get("content-type") || "";

  let type: SourceType;
  let title: string;
  let fileBuffer: Buffer | undefined;
  let rawText: string | undefined;
  let url: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    type = form.get("type") as SourceType; // "pdf" or "vtt" (file-based)
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "File required" }, { status: 400 });
    title = (form.get("title") as string) || file.name;
    fileBuffer = Buffer.from(await file.arrayBuffer());
    if (type !== "pdf") {
      rawText = fileBuffer.toString("utf-8"); // vtt/srt as text
    }

    // Store the original file so the source viewer can open it later
    // (PDF.js needs the actual bytes to jump to a page).
    const storagePath = `${notebookId}/${Date.now()}-${file.name}`;
    const { error: storageErr } = await supabaseAdmin.storage
      .from("sources")
      .upload(storagePath, fileBuffer, { contentType: file.type });
    if (storageErr) {
      return NextResponse.json({ error: storageErr.message }, { status: 500 });
    }
    url = storagePath; // reuse `url` var as the raw_ref for file-based sources too
  } else {
    const body = await req.json();
    type = body.type;
    title = body.title || body.url || "Untitled";
    rawText = body.text;
    url = body.url;
  }

  // Create the source row first so the UI can show "uploading" -> "indexing" immediately.
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .insert({ notebook_id: notebookId, type, title, status: "uploading", raw_ref: url ?? null })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Ingestion continues after this response is sent, and the client polls
  // GET /sources for status. On serverless a bare floating promise is not
  // guaranteed to run once the response is returned, which used to leave
  // sources stuck on "indexing" forever; after() keeps the function alive.
  after(async () => {
    await ingestSource({ sourceId: source.id, notebookId, type, fileBuffer, rawText, url });
  });

  return NextResponse.json(source, { status: 202 });
}
