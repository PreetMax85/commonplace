// Shared by the upload routes and the add-source form, so the form can refuse
// early with the same numbers the server enforces.

// Pasted text travels in the request body, and Vercel rejects any function
// request body over 4.5 MB before the route runs, with a plain 413 the form
// cannot show properly, so the cap sits just under it.
export const MAX_TEXT_MB = 4;
export const MAX_TEXT_BYTES = MAX_TEXT_MB * 1024 * 1024;
// Files go from the browser straight to Storage, so that limit does not apply
// to them. This one bounds the memory a function uses to read one, and the
// bucket enforces it too, since an upload link cannot limit size itself.
export const MAX_FILE_MB = 20;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
export const MAX_SOURCES_PER_NOTEBOOK = 15;
// Passages are embedded one at a time, at about 36 ms each on a laptop and
// slower on a function, so this keeps one source well inside the 300 second
// budget. It is roughly a 400 page book. File size cannot bound this, since a
// large PDF can be mostly images.
export const MAX_CHUNKS_PER_SOURCE = 1500;

// Space for everything one visitor keeps, and for the whole site. The site
// numbers stay under the free plan's 1 GB of Storage and 500 MB of database,
// which turns read-only when full and would take the demo down with it. A
// per-visitor limit alone would not protect that, since a new address makes a
// new visitor.
// A chunk measured 12 KB in the database, index included, so 30,000 is about
// 370 MB of the 500.
const MB = 1024 * 1024;
export const VISITOR_SPACE = { fileBytes: 50 * MB, chunks: 3000 };
export const SITE_SPACE = { fileBytes: 800 * MB, chunks: 30_000 };
