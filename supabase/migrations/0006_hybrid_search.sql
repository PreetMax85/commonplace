-- Keyword search alongside vector search, merged into one ranked list.
--
-- The retrieval eval showed vector search losing passages that share rare,
-- exact words with the question ("hindrance", "furtherance") to chunks that
-- are only loosely about the same topic. Full-text search catches those words
-- directly. match_chunks_hybrid runs both searches and merges them with
-- reciprocal rank fusion: each chunk scores 1 / (rrf_k + its rank) in each
-- list it appears in, and the scores are summed. Rank is used rather than the
-- raw scores because cosine similarity and ts_rank are on different scales.
--
-- match_chunks is left untouched so the eval can keep measuring the old path.
--
-- Safe to run more than once.

-- Filled in by Postgres for existing and future rows, so ingest does not change.
alter table chunks
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists chunks_fts_idx on chunks using gin (fts);

-- A question rarely contains every word of the passage that answers it, so the
-- keyword side matches chunks holding any of the question's words, not all of
-- them. plainto_tsquery drops stop words, stems the rest and quotes each word,
-- and its '&' between words is swapped for '|'. Reading the result back as a
-- tsquery is safe because the quoting already escaped any punctuation.
--
-- ts_rank counts how often the question's words appear in a chunk. It does not
-- weigh rare words above common ones, so a common word repeated often can
-- still outrank a single rare one.
--
-- Each side contributes up to twice match_count candidates before merging, so
-- a chunk ranked just outside the top of one list can still win on the other.
create or replace function match_chunks_hybrid(
  query_text text,
  query_embedding vector(384),
  match_notebook_id uuid,
  match_count int default 8,
  rrf_k int default 60
)
returns table (
  id uuid,
  source_id uuid,
  content text,
  metadata jsonb,
  similarity float,
  semantic_rank int,
  keyword_rank int,
  score float
)
language sql stable
as $$
  with query as (
    select replace(plainto_tsquery('english', query_text)::text, ' & ', ' | ')::tsquery as q
  ),
  semantic as (
    select
      chunks.id,
      row_number() over (order by chunks.embedding <=> query_embedding) as rank_ix
    from chunks
    where chunks.notebook_id = match_notebook_id
    order by chunks.embedding <=> query_embedding
    limit least(match_count, 30) * 2
  ),
  keyword as (
    select
      chunks.id,
      row_number() over (order by ts_rank(chunks.fts, query.q) desc, chunks.id) as rank_ix
    from chunks, query
    where chunks.notebook_id = match_notebook_id
      and chunks.fts @@ query.q
    order by rank_ix
    limit least(match_count, 30) * 2
  )
  select
    chunks.id,
    chunks.source_id,
    chunks.content,
    chunks.metadata,
    1 - (chunks.embedding <=> query_embedding) as similarity,
    semantic.rank_ix::int as semantic_rank,
    keyword.rank_ix::int as keyword_rank,
    (coalesce(1.0 / (rrf_k + semantic.rank_ix), 0)
      + coalesce(1.0 / (rrf_k + keyword.rank_ix), 0))::float as score
  from semantic
  full outer join keyword on keyword.id = semantic.id
  join chunks on chunks.id = coalesce(semantic.id, keyword.id)
  order by score desc, semantic_rank nulls last, chunks.id
  limit match_count;
$$;
