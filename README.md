# Commonplace

**Live:** [commonplace-lm.vercel.app](https://commonplace-lm.vercel.app). Open the notebook marked Demo to try it without uploading anything.

### Demo Video:
[Watch the demo on YouTube](https://youtu.be/jj3FkC2HFJA)

Upload PDFs, text, URLs, YouTube videos, and transcripts into isolated notebooks, ask questions, and get grounded, streamed answers with clickable citations that jump to the exact page, timestamp, or passage in the source.

## Setup

1. Create a Supabase project. Run `supabase/schema.sql` in the SQL editor. For a project created from an older schema, run the files in `supabase/migrations/` in order instead.
2. Create a private **Storage** bucket named `sources` in Supabase. The app hands out short-lived signed URLs, so the files never need to be publicly listable.
3. Copy `.env.example` to `.env.local` and fill in `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GROQ_API_KEY`.
4. `npm install`
5. `npm run dev`
6. Optional: to make a notebook the read-only public demo, run `update notebooks set is_demo = true where id = '<notebook id>';` in the SQL editor.

## Stack

- **Next.js (App Router)**: single deploy, API routes and frontend together
- **Supabase Postgres + pgvector**: notebook, source, and chunk metadata plus vector search
- **Supabase Storage**: original PDF/VTT files for the source viewer
- **Groq**: `openai/gpt-oss-120b` for grounded streamed answers and the roadmap, `openai/gpt-oss-20b` for question rewriting
- **Transformers.js** (`@xenova/transformers`): `bge-small-en-v1.5` embeddings computed in-process, no embedding API

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
6. `status → "ready"` (green dot) or `"error"` with the reason shown on the source. A source that fails partway through has its chunks deleted, so a half-indexed document is never left searchable. Re-indexing keeps the previous chunks until the new ones are fully written, so a failed re-index leaves the source as it was.

### Retrieval + answer flow

1. Embed the question.
2. `match_chunks(query_embedding, match_notebook_id, match_count)` via pgvector cosine distance, filtered per notebook.
3. Top-8 chunks sent to Groq with a prompt to answer only from context, citing every claim with `[n]`.
4. Response streams as `citations` event first, then `token` events, then `done`.
5. Clicking a citation opens the source viewer, jumping to the right page/timestamp/chunk.

### Multi-turn chat

Each question is sent with the prior conversation. A lightweight LLM call rewrites the question into standalone form for retrieval; the answer call sees the last 3 exchanges verbatim but is still instructed to answer only from retrieved context.

### Rate limits

Embeddings run locally, so indexing is never rate limited and never costs an API call. Only the Groq calls can hit a limit, and the free tier runs out of tokens per minute long before requests per minute: one grounded answer costs roughly 3k of the 8k available. The Groq SDK retries a 429 once, honouring `retry-after`, and past that the reader is told to wait rather than left watching an empty bubble. The roadmap endpoint trims transcripts to a fixed budget so a long video cannot exceed the per-minute limit on its own.

The deployed demo has no accounts, so one visitor could spend the whole Groq budget for everyone. The routes that call Groq or start an ingest count requests in Postgres (`hit_rate_limits`, migration `0005`), per IP and site-wide, in fixed windows, and answer `429` with a `Retry-After` header and a readable message once a window is full. The site-wide numbers are sized to the free tier's 200k tokens a day.

| Action | Per IP | Site-wide |
| --- | --- | --- |
| Questions | 4 per 10 minutes, 15 per day | 40 per day |
| Roadmaps | 2 per day | 8 per day |
| New notebooks | 2 per day | 20 per day |
| Adding or re-indexing sources | 8 per day | 40 per day |

Questions and roadmaps also share a site-wide limit of 2 per minute, matching the 8k tokens a minute, with a roadmap counting as two. Because the limits count requests rather than tokens, questions are capped at 1,000 characters, history at the last 6 turns of 1,500 characters each, and answers at 2,000 completion tokens. IPv6 clients are grouped by /64. A refused request is not counted, and if the counter itself cannot be reached the request is allowed rather than failing the demo. IPs are stored only as hashes, and the daily health cron deletes old windows.

## Known scope cuts

- No auth or multi-user layer yet. The public deployment is protected instead: demo notebooks are read-only, uploads and pasted text are capped at 4 MB (Vercel rejects function request bodies over 4.5 MB), and a notebook holds up to 15 sources.
- Podcast/voice-over bonus deprioritized in favor of the roadmap bonus (YouTube sources → ordered concept list grounded in transcript timestamps).
- PDF source viewer jumps to the cited page but doesn't highlight the exact passage (text/VTT/URL sources do highlight).
- Adding a new YouTube source works locally but not on the deployed site, because YouTube refuses transcript requests from cloud IPs. The demo notebook's videos were indexed locally. Uploading a VTT or SRT transcript works everywhere.
