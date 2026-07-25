import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { ingestSource, SourceType } from "@/lib/ingest";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  // Fire-and-forget ingestion; client polls GET /sources for status updates.
  ingestSource({ sourceId: source.id, notebookId, type, fileBuffer, rawText, url });

  return NextResponse.json(source, { status: 202 });
}
