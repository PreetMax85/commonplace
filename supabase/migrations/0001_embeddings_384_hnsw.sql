-- Migration for databases created from the pre-Groq schema, where the embedding
-- column was vector(1536) for Gemini embeddings and the vector index was ivfflat.
--
-- Embeddings now come from bge-small-en-v1.5 running locally, which emits 384
-- dimensions. Run this once against an existing project. Safe to run again.
--
-- Two things change here:
--   1. The vector index becomes HNSW. The old ivfflat index was created on an
--      empty table, so its centroids were chosen from no data and searches
--      probed a single badly placed list, silently missing real matches.
--   2. match_chunks is redeclared for vector(384).
--
-- If your chunks table still holds 1536-dimension vectors from the Gemini era,
-- those rows cannot be converted and must be cleared before the column type can
-- change. That step is deliberately left manual, because it discards indexed
-- content. Run it yourself, then re-index each source from the app:
--
--   delete from chunks;
--   alter table chunks alter column embedding type vector(384);

begin;

drop index if exists chunks_embedding_idx;

create index if not exists chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);

drop function if exists match_chunks(vector, uuid, int);

create or replace function match_chunks(
  query_embedding vector(384),
  match_notebook_id uuid,
  match_count int default 8
)
returns table (
  id uuid,
  source_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    chunks.id,
    chunks.source_id,
    chunks.content,
    chunks.metadata,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where chunks.notebook_id = match_notebook_id
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;

commit;
