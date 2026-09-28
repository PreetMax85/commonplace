import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { ingestSource, SourceType } from "@/lib/ingest";
import { extractYoutubeId } from "@/lib/extract/youtube";
import { checkNotebook } from "@/lib/access";
import { MAX_FILE_BYTES, MAX_FILE_MB, MAX_TEXT_BYTES, MAX_TEXT_MB } from "@/lib/limits";
import { enforceRateLimit } from "@/lib/rateLimit";
import { checkSourceCount, checkSpace } from "@/lib/space";
import { removeSourceFile } from "@/lib/storage";

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

// The names /uploads gives files: a timestamp, a random id and the type.
const UPLOAD_NAME = /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|vtt|srt)$/;

function tooLarge(mb: number) {
  return NextResponse.json({ error: `Sources can be up to ${mb} MB.` }, { status: 413 });
}

// Only the shape of the link. Whether it reaches a public address is checked
// when the page is fetched, on every redirect.
function isWebLink(url: string | undefined): boolean {
  try {
    const { protocol } = new URL(url ?? "");
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

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
  const refused = await checkNotebook(id, "read");
  if (refused) return refused;
  await failStalledSources(id);
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("notebook_id", id)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// JSON for every type. A pdf or vtt has already gone straight to Storage
// through /uploads and arrives here as its path.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: notebookId } = await params;
  const refused = await checkNotebook(notebookId, "write");
  if (refused) return refused;

  // Refuse an oversized body before parsing it into memory, allowing a little
  // room for the JSON around pasted text. The header can be absent, so the
  // text check below still applies.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_TEXT_BYTES + 256 * 1024) {
    return tooLarge(MAX_TEXT_MB);
  }

  // Pages loaded before uploads moved to Storage still send the file here.
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    return NextResponse.json({ error: "This page is out of date. Refresh it and add the file again." }, { status: 400 });
  }

  const body = await req.json();
  const type: SourceType = body.type;
  if (!["pdf", "vtt", "text", "url", "youtube"].includes(type)) {
    return NextResponse.json({ error: "Unknown source type." }, { status: 400 });
  }
  const typed = typeof body.title === "string" ? body.title.trim() : "";
  let title: string;
  let fileBuffer: Buffer | undefined;
  let rawText: string | undefined;
  let url: string | undefined;
  // Whether ingest may replace the title with the one the source names itself.
  let autoTitle = false;
  // Set once an uploaded file is known to belong to no other source, so a
  // refusal from then on removes it rather than leaving it to count against
  // the visitor until the daily sweep.
  let uploadedPath: string | undefined;
  const refuse = async (response: NextResponse) => {
    if (uploadedPath) await removeSourceFile(uploadedPath);
    return response;
  };

  if (type === "pdf" || type === "vtt") {
    const path = typeof body.path === "string" ? body.path : "";
    // Only a name /uploads could have made, in this notebook's own folder.
    // Storage's client does not escape paths, so anything looser, such as a
    // backslash or "..", could reach another notebook's file.
    const name = path.startsWith(`${notebookId}/`) ? path.slice(notebookId.length + 1) : "";
    if (!UPLOAD_NAME.test(name)) {
      return NextResponse.json({ error: "Upload the file first." }, { status: 400 });
    }
    // Two sources on one file would lose it for both when either is removed.
    const { data: used, error: usedError } = await supabaseAdmin
      .from("sources")
      .select("id")
      .eq("raw_ref", path)
      .limit(1);
    if (usedError) throw usedError;
    if (used.length) return NextResponse.json({ error: "That file has already been added." }, { status: 409 });

    const { data: file, error: downloadError } = await supabaseAdmin.storage.from("sources").download(path);
    if (downloadError || !file) {
      return NextResponse.json({ error: "The file did not finish uploading. Try again." }, { status: 400 });
    }
    uploadedPath = path;
    fileBuffer = Buffer.from(await file.arrayBuffer());
    if (fileBuffer.length > MAX_FILE_BYTES) return refuse(tooLarge(MAX_FILE_MB));
    if (type === "vtt") rawText = fileBuffer.toString("utf-8");
    title = typed.slice(0, 200) || "Untitled file";
    url = path; // the raw_ref for file-based sources
  } else {
    // A page loaded before this change sends the link itself when the title
    // box is left empty, so that counts as no title too.
    autoTitle = !typed || typed === body.url?.trim();
    title = typed || body.url || "Untitled";
    rawText = body.text;
    url = body.url;
    if (rawText && Buffer.byteLength(rawText) > MAX_TEXT_BYTES) return tooLarge(MAX_TEXT_MB);
  }

  // An unparseable link would otherwise fail later, inside the background
  // ingest, having already spent one of the few daily video slots.
  if (type === "youtube") {
    try {
      extractYoutubeId(url ?? "");
    } catch {
      return NextResponse.json({ error: "That does not look like a YouTube video link." }, { status: 400 });
    }
  }
  if (type === "url" && !isWebLink(url)) {
    return NextResponse.json({ error: "Enter a full web link starting with http:// or https://." }, { status: 400 });
  }

  // An uploaded file is already stored, so it is part of what this counts.
  // Before the rate limit, so a refusal here does not spend one of the day's slots.
  const noRoom = (await checkSourceCount(notebookId)) ?? (await checkSpace(notebookId));
  if (noRoom) return refuse(noRoom);

  // A file was counted when its upload link was handed out. Videos count
  // against the transcript service's credits as well, so they are counted
  // under their own rules, which include these same source limits.
  if (!uploadedPath) {
    const limited = await enforceRateLimit(req, type === "youtube" ? "youtube" : "source");
    if (limited) return limited;
  }

  // Create the source row first so the UI can show "uploading" -> "indexing" immediately.
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .insert({ notebook_id: notebookId, type, title, status: "uploading", raw_ref: url ?? null })
    .select()
    .single();
  if (error) return refuse(NextResponse.json({ error: error.message }, { status: 500 }));

  // Ingestion continues after this response is sent, and the client polls
  // GET /sources for status. On serverless a bare floating promise is not
  // guaranteed to run once the response is returned, which used to leave
  // sources stuck on "indexing" forever; after() keeps the function alive.
  after(async () => {
    await ingestSource({ sourceId: source.id, notebookId, type, fileBuffer, rawText, url, autoTitle });
  });

  return NextResponse.json(source, { status: 202 });
}
