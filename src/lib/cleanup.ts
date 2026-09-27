import { supabaseAdmin } from "./supabase";
import { BUCKET, removeNotebookFiles } from "./storage";

// Visitors are anonymous accounts, and Supabase never removes those on its
// own. The daily cron removes each one 30 days after it was made: first the
// stored files, which no database cascade reaches, then the user, which
// cascades to their notebooks, sources and chunks. The home page promises
// this window, so change the copy there if this changes.
const RETENTION = "30 days";

// Each visitor takes a few round trips, so this finishes well inside the
// function's time limit while staying ahead of a day of bot sign-ups, which
// Supabase caps at 30 an hour per address. Anything left over waits a day.
const MAX_PER_RUN = 200;

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

// Files uploaded straight from the browser that never became a source: an
// upload abandoned halfway, or one refused after it arrived. A day is far
// longer than adding a source takes, so nothing still in progress is touched.
export async function removeUnregisteredUploads(): Promise<void> {
  const [{ data: paths, error }, { data: demos, error: demoError }] = await Promise.all([
    supabaseAdmin.rpc("unregistered_uploads", { max_age: "1 day" }),
    supabaseAdmin.from("notebooks").select("id").eq("is_demo", true),
  ]);
  if (error || demoError) {
    console.error("Finding unregistered uploads failed:", error ?? demoError);
    return;
  }
  // The demo's files are never removed here, whatever the query returns.
  const demoFolders = (demos ?? []).map((d) => `${d.id}/`);
  const orphans = (paths as string[]).filter((p) => !demoFolders.some((folder) => p.startsWith(folder)));

  for (let i = 0; i < orphans.length; i += 100) {
    const { error: removeError } = await supabaseAdmin.storage.from(BUCKET).remove(orphans.slice(i, i + 100));
    if (removeError) console.error("Removing unregistered uploads failed:", removeError);
  }
}
