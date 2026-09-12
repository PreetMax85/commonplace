import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !source) return NextResponse.json({ error: "Source not found" }, { status: 404 });

  const { data: chunks } = await supabaseAdmin
    .from("chunks")
    .select("id, content, metadata")
    .eq("source_id", id)
    // Ordering by metadata->chunk_index put the viewer in the wrong order for
    // every source type: it restarts at 0 on each PDF page, so pages
    // interleaved, and YouTube and VTT chunks never carry it, so their order
    // was whatever the database happened to return.
    .order("ordinal", { ascending: true });

  let fileUrl: string | null = null;
  if (source.type === "pdf" || source.type === "vtt") {
    const { data: signed } = await supabaseAdmin.storage
      .from("sources")
      .createSignedUrl(source.raw_ref, 60 * 10); // 10 min
    fileUrl = signed?.signedUrl ?? null;
  }

  return NextResponse.json({ source, chunks, fileUrl });
}
