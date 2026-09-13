import { NextResponse } from "next/server";
import { supabaseAdmin } from "./supabase";

// The demo notebook is shared by every visitor, and without auth there is no
// way to tell its owner from anyone else. Routes that change or remove a
// notebook's content refuse when it is flagged, so one visitor cannot empty it
// for the next. Lookup errors throw rather than read as "not a demo", so an
// outage never waves a destructive request through.

export async function isDemoNotebook(notebookId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("notebooks")
    .select("is_demo")
    .eq("id", notebookId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_demo === true;
}

export async function isDemoSource(sourceId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("sources")
    .select("notebook_id")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw error;
  return data ? isDemoNotebook(data.notebook_id) : false;
}

export function demoReadOnlyResponse() {
  return NextResponse.json(
    { error: "The demo notebook is read-only. Create your own notebook to add or change sources." },
    { status: 403 }
  );
}
