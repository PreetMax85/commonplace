import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { checkNotebook } from "@/lib/access";
import { MAX_FILE_BYTES, MAX_FILE_MB } from "@/lib/limits";
import { checkSourceCount, checkSpace } from "@/lib/space";
import { enforceRateLimit } from "@/lib/rateLimit";

// Vercel refuses any function request body over 4.5 MB, so files skip the
// server: this hands out a one-time link to upload one file straight to
// Storage, after the same checks as adding any other source. The browser then
// adds the source by its path through POST /sources. The rate limit is counted
// here, where the bytes are let in, and not again there.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: notebookId } = await params;
  const refused = await checkNotebook(notebookId, "write");
  if (refused) return refused;

  const body = await req.json().catch(() => null);
  const { type, name, size } = body ?? {};
  if (type !== "pdf" && type !== "vtt") {
    return NextResponse.json({ error: "Only PDF and transcript files are uploaded." }, { status: 400 });
  }
  if (typeof name !== "string" || !name || typeof size !== "number" || !(size > 0)) {
    return NextResponse.json({ error: "Choose a file first." }, { status: 400 });
  }
  // The browser reports the size, so this is only a courtesy. The bucket's own
  // limit and the check when the source is added are what hold.
  if (size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: `Files can be up to ${MAX_FILE_MB} MB.` }, { status: 413 });
  }

  const noRoom = (await checkSourceCount(notebookId)) ?? (await checkSpace(notebookId, size));
  if (noRoom) return noRoom;
  const limited = await enforceRateLimit(req, "source");
  if (limited) return limited;

  // A slash in the name would nest the file below the notebook's folder,
  // where deleting the notebook, which lists one level, would not find it.
  const path = `${notebookId}/${Date.now()}-${name.replace(/[/\\]/g, "_")}`;
  const { data, error } = await supabaseAdmin.storage.from("sources").createSignedUploadUrl(path);
  if (error) {
    console.error(`Creating an upload link for ${path} failed:`, error);
    return NextResponse.json({ error: "The upload could not be started. Try again." }, { status: 500 });
  }
  return NextResponse.json({ path: data.path, token: data.token });
}
