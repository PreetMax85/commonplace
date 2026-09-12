-- Migration for databases created from the pre-Groq schema, where the embedding
-- column was vector(1536) for Gemini embeddings and the vector index was ivfflat.
--
-- Two things change:
--   1. The vector index becomes HNSW. The old ivfflat index was created on an
--      empty table, so its centroids were chosen from no data, and searches
--      probed a single badly placed list, silently missing real matches.
--   2. match_chunks is redeclared for vector(384), the size that
--      bge-small-en-v1.5 emits.
--
-- The column type itself is NOT changed here. Existing 1536-dimension vectors
-- cannot be converted to 384, so the only way through is to discard them and
-- re-index each source from the app. That destroys indexed content, so it stays
-- a deliberate act rather than something this file does on your behalf:
--
--   delete from chunks;
--   alter table chunks alter column embedding type vector(384);
--
-- Running this migration against a column that is still 1536 would leave a
-- database that looks migrated and fails at query time with "different vector
-- dimensions 1536 and 384", so it refuses to run instead. Safe to run again.

begin;

do $$
declare
  dims int;
begin
  select atttypmod into dims
  from pg_attribute
  where attrelid = 'chunks'::regclass
    and attname = 'embedding'
    and not attisdropped;

  if dims is distinct from 384 then
    raise exception
      'chunks.embedding is % dimensions, expected 384. Clear the old vectors and change the column type first (see the comment at the top of this file), then re-run.', dims;
  end if;
end $$;

drop index if exists chunks_embedding_idx;

create index chunks_embedding_idx on chunks
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
