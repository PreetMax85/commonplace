import { supabaseAdmin } from "./supabase";
import { removeNotebookFiles } from "./storage";

// Visitors are anonymous accounts, and Supabase never removes those on its
// own. The daily cron removes each one 30 days after it was made: first the
// stored files, which no database cascade reaches, then the user, which
// cascades to their notebooks, sources and chunks. The home page promises
// this window, so change the copy there if this changes.
const RETENTION = "30 days";

// Enough to keep up with a busy day, small enough to finish well inside the
// function's time limit. Anything left over is picked up the next day.
const MAX_PER_RUN = 50;

export async function removeExpiredVisitors(): Promise<void> {
  const { data: expired, error } = await supabaseAdmin.rpc("expired_anonymous_users", {
    max_age: RETENTION,
  });
  if (error) {
    console.error("Finding expired visitors failed:", error);
    return;
  }

  for (const userId of (expired as string[]).slice(0, MAX_PER_RUN)) {
    const { data: notebooks, error: listError } = await supabaseAdmin
      .from("notebooks")
      .select("id")
      .eq("owner_id", userId);
    // Deleting the user without the list would orphan their files for good.
    if (listError) {
      console.error(`Listing notebooks for visitor ${userId} failed:`, listError);
      continue;
    }
    let filesRemoved = true;
    for (const { id } of notebooks ?? []) filesRemoved = (await removeNotebookFiles(id)) && filesRemoved;
    // Same reason: the user is the only link back to these files. Try again tomorrow.
    if (!filesRemoved) continue;

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (deleteError) console.error(`Deleting visitor ${userId} failed:`, deleteError);
  }
}
