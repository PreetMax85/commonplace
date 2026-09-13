import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Hit daily by a Vercel cron. A free Supabase project pauses after a week
// without activity, which is how an earlier deployment went dark, so this
// runs one cheap query to count as activity. It also works as a manual check
// that the deployment can reach the database.
export async function GET() {
  const { error } = await supabaseAdmin.from("notebooks").select("id").limit(1);
  if (error) {
    // The endpoint is public, so the details stay in the logs.
    console.error("Health check query failed:", error);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
