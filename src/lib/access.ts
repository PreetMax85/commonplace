import { NextResponse } from "next/server";
import { supabaseAdmin } from "./supabase";
import { getVisitorId } from "./visitor";

// Every notebook belongs to the anonymous visitor who created it, except the
// demo, which belongs to no one: everyone may read it and no one may change
// it. A notebook the visitor may not read answers exactly like one that does
// not exist, so ids cannot be probed for.
//
// Each check returns a response to send back when access is refused, or null
// to carry on. Lookup errors throw, so an outage becomes a 500 rather than
// being read as either answer.

type Mode = "read" | "write";

// Postgres rejects a malformed uuid with this code. That is a bad link, not an outage.
const INVALID_UUID = "22P02";

function notFound() {
  return NextResponse.json({ error: "Notebook not found" }, { status: 404 });
}

function demoReadOnly() {
  return NextResponse.json(
    { error: "The demo notebook is read-only. Create your own notebook to add or change sources." },
    { status: 403 }
  );
}

export async function checkNotebook(notebookId: string, mode: Mode): Promise<NextResponse | null> {
  const { data: notebook, error } = await supabaseAdmin
    .from("notebooks")
    .select("is_demo, owner_id")
    .eq("id", notebookId)
    .maybeSingle();
  if (error && error.code !== INVALID_UUID) throw error;
  if (!notebook) return notFound();

  if (notebook.is_demo) return mode === "write" ? demoReadOnly() : null;
  const visitorId = await getVisitorId();
  return visitorId !== null && notebook.owner_id === visitorId ? null : notFound();
}

export async function checkSource(sourceId: string, mode: Mode): Promise<NextResponse | null> {
  const { data: source, error } = await supabaseAdmin
    .from("sources")
    .select("notebook_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (error && error.code !== INVALID_UUID) throw error;
  const missing = NextResponse.json({ error: "Source not found" }, { status: 404 });
  if (!source) return missing;
  const refused = await checkNotebook(source.notebook_id, mode);
  // Someone else's source reads as missing too, not as a missing notebook.
  return refused?.status === 404 ? missing : refused;
}
