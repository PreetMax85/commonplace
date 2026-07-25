# Notebook RAG — Gemini NotebookLM-style research assistant

Multi-source, multi-notebook RAG app. Upload PDFs, text, web links, YouTube
videos, and VTT/SRT transcripts into isolated notebooks; ask questions;
get grounded, streamed answers with clickable citations that jump to the
exact page, timestamp, or highlighted passage in the original source.

## Design

Styled after Hallmark's (nutlope/hallmark) **Hum** theme — the playful/organic genre, "post-Linear soft school." Applied by hand (Hallmark is a rule-set for AI coding agents like Claude Code, not a drop-in CSS file), following its documented foundations:

- **One anchor hue.** A single warm coral accent (`--color-accent`, OKLCH), used under ~5% of the page — primary buttons, active states, links. Everything else is a chroma-tinted warm neutral, never pure `#000`/`#fff`/Tailwind gray.
- **Type pairing.** Plus Jakarta Sans (display, warm humanist-rounded — Hum's signature face) + Inter (body). Never the same face doing both jobs.
- **Generous rounding.** `--radius-md`/`--radius-lg` and pill-shaped inputs/buttons for the soft, organic feel the genre calls for.
- **Exponential ease-out motion**, with a `prefers-reduced-motion` fallback on every transition.

All tokens live in `src/app/globals.css` as CSS custom properties, mapped into Tailwind v4's `@theme` block — so `bg-paper`, `text-ink`, `bg-accent`, etc. are real utility classes, not one-off hex values scattered through components.

## Stack

- **Next.js (App Router)** — single deploy, API routes + frontend together
- **Supabase Postgres + pgvector** — notebook/source/chunk metadata and vector search in one DB (no separate vector service to run)
- **Supabase Storage** — original PDF/VTT files, so the source viewer can open them later
- **Gemini API (free tier)** — `text-embedding-004` for embeddings, `gemini-2.0-flash` for grounded, streamed answers

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor (enables `pgvector`, creates tables + the `match_chunks` RPC used for notebook-isolated similarity search).
2. Create a public **Storage bucket** named `sources` in Supabase (for original PDF/VTT files).
3. Copy `.env.example` to `.env.local` and fill in:
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API)
   - `GEMINI_API_KEY` (aistudio.google.com/apikey)
4. `npm install`
5. `npm run dev`

## Migration note (if you already ran the old schema.sql)

Google deprecated `text-embedding-004` — this project now uses `gemini-embedding-001`, truncated+renormalized to 1536 dims (its native 3072 exceeds pgvector's 2000-dim index limit). If your Supabase project already has the old `vector(768)` column, run this before ingesting anything:

```sql
truncate table chunks;
alter table chunks alter column embedding type vector(1536);
drop function if exists match_chunks(vector(768), uuid, int);
```

Then re-run the `match_chunks` function block from `supabase/schema.sql` to recreate it with the new signature. Sources already marked `error` can just be deleted and re-added.

## Architecture

```
notebooks (1) ──< sources (many) ──< chunks (many, with embedding vector(768))
```

- Every chunk carries `notebook_id` (denormalized) so vector search can be
  filtered per notebook in a single query — this is what enforces notebook
  isolation, not application-level filtering after the fact.
- `metadata` (jsonb) on each chunk holds whatever anchor its source type
  supports: PDF → `page`; YouTube/VTT → `timestamp_start`/`timestamp_end`;
  text/URL → `chunk_index` + `section`.

### Ingestion flow (`src/lib/ingest.ts`)

1. Source row created with `status: "uploading"` → returned to client immediately (UI shows the grey/uploading dot).
2. Background ingestion kicks off: `status → "indexing"` (yellow dot).
3. Type-specific extractor (`src/lib/extract/*.ts`) pulls text + per-segment metadata.
4. Shared `chunkText()` splits long segments (PDF pages, article text) further, ~1000 chars with 150 overlap, preserving the segment's metadata on every sub-chunk.
5. Chunks embedded (Gemini `text-embedding-004`) and inserted into `chunks`.
6. `status → "ready"` (green dot), or `"error"` with `error_message` on failure — never silently stuck on "indexing".

### Retrieval + answer flow (`/api/query`)

1. Embed the question.
2. `match_chunks(query_embedding, match_notebook_id, match_count)` — a Postgres RPC using pgvector cosine distance, filtered to the current notebook only.
3. Top-8 chunks sent to Gemini with an explicit "answer only from this context, cite every claim with `[n]`, say so if the answer isn't here" prompt.
4. Response streams over SSE-style chunks: a `citations` event first (so the UI can render clickable `[n]` immediately), then `token` events as the answer generates, then `done`.
5. Clicking a citation opens `SourceViewer`, which fetches `/api/sources/:id/view` and jumps to the right page (PDF), timestamp (YouTube), or highlights the matching chunk (text/VTT/URL).

### Source removal / re-indexing

- Delete cascades from `sources` → `chunks` via FK, and removes storage files for file-based sources.
- Re-index: URL/YouTube sources re-fetch and re-chunk in place (content can change or transcripts can improve). PDF/text/VTT re-index requires re-uploading, since the original isn't held in memory after ingestion — only in Storage for file types, or not retained raw for pasted text.

### Re-indexing (all 5 source types)

- URL/YouTube: re-fetch live and re-chunk (content may have changed).
- PDF/VTT: original file is re-downloaded from Supabase Storage and re-extracted.
- Text: the pasted text is saved as `raw_ref` on first ingest, so re-index re-chunks it without asking you to re-paste.

### Rate limits

`src/lib/gemini.ts` retries embedding calls and answer-stream start with exponential backoff (up to 5 attempts) specifically on 429/quota errors — other errors fail fast rather than retrying something that will never succeed. A chunk that still fails after retries fails the whole source (marked `error`, with the message shown in the UI) rather than silently storing partial data.

### Multi-turn chat

Each question is sent with the full prior conversation. Two things happen with that history:
1. A lightweight LLM call rewrites the question into a standalone form for retrieval (so "what about the second one?" embeds something searchable instead of a bare pronoun).
2. The answer-generation call sees the last 3 exchanges verbatim, so it can resolve references — but is still instructed to answer only from the retrieved context, never from conversation memory.

## UX details

- Workspace header shows the notebook name (click to rename inline) and a back link — `GET /api/notebooks/:id` backs this.
- Source list shows a per-row loading indicator during delete/re-index, and surfaces `error_message` inline under any source stuck in the red/error state — ingestion failures are never silent.
- Add Source modal validates before submitting (missing file/URL/text) and surfaces the API's actual error message on failure instead of failing silently.
- Empty states: no notebooks, no sources, no chat messages yet, and "click a citation to view its source" all have their own copy instead of a blank pane.

## Known scope cuts (documented, not hidden)

- Podcast/voice-over bonus was deprioritized in favor of shipping the roadmap bonus and a solid core — see `/api/roadmap` for the personalized-learning-roadmap bonus (YouTube sources → ordered concept list grounded in transcript timestamps).
- No auth/multi-user layer — single-tenant by design for this assignment's scope.
- PDF source viewer jumps to the cited page but doesn't highlight the exact passage on it (text/VTT/URL sources do highlight; PDF text-layer highlighting needs PDF.js's text layer, not wired up yet).
