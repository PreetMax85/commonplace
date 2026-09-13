// Shared by the upload route and the add-source form, so the form can refuse
// early with the same numbers the server enforces. Embedding runs in-process,
// so these also bound how long one upload can hold a function.
export const MAX_UPLOAD_MB = 20;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_SOURCES_PER_NOTEBOOK = 15;
