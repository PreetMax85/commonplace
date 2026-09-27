import { NextResponse } from "next/server";
import { supabaseAdmin } from "./supabase";
import { MAX_SOURCES_PER_NOTEBOOK, SITE_SPACE, VISITOR_SPACE } from "./limits";

type Usage = { file_bytes: number; chunk_count: number };

async function spaceUsed(ownerId: string | null): Promise<Usage> {
  const { data, error } = await supabaseAdmin.rpc("space_used", ownerId ? { for_owner: ownerId } : {});
  if (error) throw error;
  const row = (data as Usage[])[0];
  return { file_bytes: Number(row.file_bytes), chunk_count: Number(row.chunk_count) };
}

function mb(bytes: number) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// Refuses a new source when the notebook's owner, or the site as a whole, is
// out of room. incomingBytes is the size of a file about to be uploaded. A
// source's passages are only known once it is read, so those are checked
// against what is already stored: one source can pass the line by at most its
// own cap, which is the price of not reading a file twice.
export async function checkSpace(notebookId: string, incomingBytes = 0): Promise<NextResponse | null> {
  const { data: notebook, error } = await supabaseAdmin
    .from("notebooks")
    .select("owner_id")
    .eq("id", notebookId)
    .single();
  if (error) throw error;

  const [visitor, site] = await Promise.all([spaceUsed(notebook.owner_id), spaceUsed(null)]);

  if (
    visitor.file_bytes + incomingBytes > VISITOR_SPACE.fileBytes ||
    visitor.chunk_count >= VISITOR_SPACE.chunks
  ) {
    return NextResponse.json(
      {
        error: `Not enough room. Your notebooks hold ${mb(visitor.file_bytes)} of files and ${visitor.chunk_count.toLocaleString("en")} passages, out of ${mb(VISITOR_SPACE.fileBytes)} and ${VISITOR_SPACE.chunks.toLocaleString("en")}. Remove a source to make room.`,
      },
      { status: 409 }
    );
  }
  if (site.file_bytes + incomingBytes > SITE_SPACE.fileBytes || site.chunk_count >= SITE_SPACE.chunks) {
    console.warn("Site space limit reached:", site);
    return NextResponse.json(
      { error: "The site has run out of room for new sources. Try again in a few days." },
      { status: 503 }
    );
  }
  return null;
}

export async function checkSourceCount(notebookId: string): Promise<NextResponse | null> {
  const { count, error } = await supabaseAdmin
    .from("sources")
    .select("id", { count: "exact", head: true })
    .eq("notebook_id", notebookId);
  if (error) throw error;
  if ((count ?? 0) < MAX_SOURCES_PER_NOTEBOOK) return null;
  return NextResponse.json(
    { error: `A notebook can hold up to ${MAX_SOURCES_PER_NOTEBOOK} sources. Remove one to add another.` },
    { status: 409 }
  );
}
