// Shared by the upload route and the add-source form, so the form can refuse
// early with the same numbers the server enforces. Embedding runs in-process,
// so these also bound how long one upload can hold a function. Vercel rejects
// any function request body over 4.5 MB before the route runs, with a plain
// 413 the form cannot show properly, so the cap sits just under it.
export const MAX_UPLOAD_MB = 4;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_SOURCES_PER_NOTEBOOK = 15;
