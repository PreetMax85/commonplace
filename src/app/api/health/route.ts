import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { removeExpiredVisitors } from "@/lib/cleanup";

// Hit daily by a Vercel cron. A free Supabase project pauses after a week
// without activity, which is how an earlier deployment went dark, so this
// runs one cheap query to count as activity. It also works as a manual check
// that the deployment can reach the database.
export async function GET(req: NextRequest) {
  const { error } = await supabaseAdmin.from("notebooks").select("id").limit(1);
  if (error) {
    // The endpoint is public, so the details stay in the logs.
    console.error("Health check query failed:", error);
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  // The same daily run clears finished rate limit windows. The longest window
  // is a day, so anything older than two days can no longer be counted against.
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  // A refused request is refunded rather than deleted, so a burst of refusals
  // from new addresses leaves rows at zero. Those count nothing and can go too.
  const { error: pruneError } = await supabaseAdmin
    .from("rate_limits")
    .delete()
    .or(`window_start.lt.${cutoff},count.lte.0`);
  if (pruneError) console.error("Rate limit prune failed:", pruneError);

  // And removes visitors past the 30 days the home page promises. The rest of
  // this endpoint is public, but this part only runs for the cron itself:
  // Vercel sends CRON_SECRET as a bearer token when that variable is set, so
  // strangers cannot make it scan and delete accounts on demand.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("authorization") === `Bearer ${cronSecret}`) {
    await removeExpiredVisitors();
  }

  return NextResponse.json({ ok: true });
}
