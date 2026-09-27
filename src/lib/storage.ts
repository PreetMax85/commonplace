import { supabaseAdmin } from "./supabase";

// Uploaded PDFs and transcripts live in the private "sources" bucket under
// <notebook id>/. Deleting a row cascades through the database, but Storage is
// not part of it, so the files are removed here. Failures are logged rather
// than thrown: the row is already gone, and a leftover file is a better
// outcome than reporting a delete that did happen as failed. The result says
// whether it worked, for callers that must not go on without it.

export const BUCKET = "sources";

export async function removeNotebookFiles(notebookId: string): Promise<boolean> {
  // A notebook holds at most 15 sources, well under one page of results.
  const { data: files, error } = await supabaseAdmin.storage.from(BUCKET).list(notebookId, { limit: 1000 });
  if (error) {
    console.error(`Listing files for notebook ${notebookId} failed:`, error);
    return false;
  }
  if (!files?.length) return true;
  const { error: removeError } = await supabaseAdmin.storage
    .from(BUCKET)
    .remove(files.map((f) => `${notebookId}/${f.name}`));
  if (removeError) {
    console.error(`Removing files for notebook ${notebookId} failed:`, removeError);
    return false;
  }
  return true;
}

export async function removeSourceFile(path: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove([path]);
  if (error) console.error(`Removing file ${path} failed:`, error);
}
