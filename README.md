# Notebook RAG — Groq-powered research assistant

[Demo](YOUR_DEMO_VIDEO_URL_HERE)

Upload PDFs, text, URLs, YouTube videos, and transcripts into isolated notebooks, ask questions, and get grounded, streamed answers with clickable citations that jump to the exact page, timestamp, or passage in the source.

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor.
2. Create a public **Storage** bucket named `sources` in Supabase.
3. Copy `.env.example` to `.env.local` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GROQ_API_KEY`.
4. `npm install`
5. `npm run dev`

## Stack

- **Next.js (App Router)** — single deploy, API routes + frontend together
- **Supabase Postgres + pgvector** — notebook/source/chunk metadata and vector search
- **Supabase Storage** — original PDF/VTT files for source viewer
- **Groq** — `llama-3.3-70b-versatile` for grounded, streamed answers
- **@xenova/transformers** — local embeddings (`bge-small-en-v1.5`)

## Architecture

```
notebooks (1) ──< sources (many) ──< chunks (many, with embedding vector)
```

- Every chunk carries `notebook_id` for per-notebook vector search isolation.
- `metadata` (jsonb) on each chunk anchors citations: PDF → `page`; YouTube/VTT → `timestamp_start`/`timestamp_end`; text/URL → `chunk_index` + `section`.

### Ingestion flow

1. Source row created with `status: "uploading"` → returned to client immediately.
2. Background ingestion: `status → "indexing"`.
3. Type-specific extractor pulls text + per-segment metadata.
4. Shared `chunkText()` splits long segments further (~1000 chars, 150 overlap), preserving metadata on every sub-chunk.
5. Chunks embedded and inserted into `chunks`.
6. `status → "ready"` (green dot) or `"error"` with message — never silently stuck.

### Retrieval + answer flow

1. Embed the question.
2. `match_chunks(query_embedding, match_notebook_id, match_count)` via pgvector cosine distance, filtered per notebook.
3. Top-8 chunks sent to Groq with a prompt to answer only from context, citing every claim with `[n]`.
4. Response streams as `citations` event first, then `token` events, then `done`.
5. Clicking a citation opens the source viewer, jumping to the right page/timestamp/chunk.

### Multi-turn chat

Each question is sent with the prior conversation. A lightweight LLM call rewrites the question into standalone form for retrieval; the answer call sees the last 3 exchanges verbatim but is still instructed to answer only from retrieved context.

### Rate limits

Retries on embedding calls and answer-stream start use exponential backoff on 429/quota errors — other errors fail fast. A chunk that fails after retries marks the whole source as `error`.

## Known scope cuts

- No auth/multi-user layer — single-tenant by design.
- Podcast/voice-over bonus deprioritized in favor of the roadmap bonus (YouTube sources → ordered concept list grounded in transcript timestamps).
- PDF source viewer jumps to the cited page but doesn't highlight the exact passage (text/VTT/URL sources do highlight).
