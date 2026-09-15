import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { reindexSource, recordFailure } from "@/lib/ingest";
import { isDemoSource, demoReadOnlyResponse } from "@/lib/demo";
import { enforceRateLimit } from "@/lib/rateLimit";

// Re-extracting and re-embedding a source takes as long as the original
// ingest, and after() runs on this budget.
export const maxDuration = 300;

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (await isDemoSource(id)) return demoReadOnlyResponse();
  // Cascades to chunks via FK on delete cascade.
  const { error } = await supabaseAdmin.from("sources").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// Re-index in place. Every source type is re-fetchable without a re-upload:
// url and youtube from the live URL, pdf and vtt from the original file in
// Storage, text from the raw text saved as raw_ref on first ingest.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (await isDemoSource(id)) return demoReadOnlyResponse();

  const { data: source } = await supabaseAdmin
    .from("sources")
    .select("id")
    .eq("id", id)
    .single();
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

  // Checked before the status claim below, so a refused request never leaves
  // the source reading "indexing".
  const limited = await enforceRateLimit(req, "source");
  if (limited) return limited;

  // Flip the status before responding. The client reloads its list as soon as
  // this returns and only keeps polling while something is in flight, so a
  // status still reading "ready" here would stop the poll and leave the UI
  // frozen on stale state until a manual refresh.
  // The flip only claims a source that is not already in flight. Two re-indexes
  // started together would each read the same old chunks, write a full new
  // set and delete only the old one, leaving two copies behind. Postgres
  // re-checks the condition under the row lock, so only one request wins.
  const { data: claimed, error: statusError } = await supabaseAdmin
    .from("sources")
    .update({ status: "indexing", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .not("status", "in", "(uploading,indexing)")
    .select("id");
  if (statusError) {
    return NextResponse.json({ error: statusError.message }, { status: 500 });
  }
  if (!claimed?.length) {
    return NextResponse.json({ error: "This source is already being indexed." }, { status: 409 });
  }

  // The work itself outlives the response, as it does for a new upload.
  after(async () => {
    try {
      await reindexSource(id);
    } catch (err: any) {
      // ingestSource handles its own failures, so reaching here means the
      // re-index failed before ingestion started, for example a file that is
      // no longer in Storage. The old chunks are untouched at that point.
      console.error(`Re-index failed for source ${id}:`, err);
      const { count } = await supabaseAdmin
        .from("chunks")
        .select("id", { count: "exact", head: true })
        .eq("source_id", id);
      await recordFailure(id, err?.message ?? String(err), (count ?? 0) > 0);
    }
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
