import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { reindexSource } from "@/lib/ingest";

// Re-extracting and re-embedding a source takes as long as the original
// ingest, and after() runs on this budget.
export const maxDuration = 300;

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Cascades to chunks via FK on delete cascade.
  const { error } = await supabaseAdmin.from("sources").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// Re-index in place. Every source type is re-fetchable without a re-upload:
// url and youtube from the live URL, pdf and vtt from the original file in
// Storage, text from the raw text saved as raw_ref on first ingest.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { data: source } = await supabaseAdmin
    .from("sources")
    .select("id")
    .eq("id", id)
    .single();
  if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

  // Flip the status before responding. The client reloads its list as soon as
  // this returns and only keeps polling while something is in flight, so a
  // status still reading "ready" here would stop the poll and leave the UI
  // frozen on stale state until a manual refresh.
  const { error: statusError } = await supabaseAdmin
    .from("sources")
    .update({ status: "indexing", error_message: null, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (statusError) {
    return NextResponse.json({ error: statusError.message }, { status: 500 });
  }

  // The work itself outlives the response, as it does for a new upload.
  after(async () => {
    try {
      await reindexSource(id);
    } catch (err: any) {
      // ingestSource handles its own failures, so reaching here means the
      // re-index failed before ingestion started, for example a file that is
      // no longer in Storage.
      console.error(`Re-index failed for source ${id}:`, err);
      await supabaseAdmin
        .from("sources")
        .update({
          status: "error",
          error_message: err?.message ?? String(err),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
