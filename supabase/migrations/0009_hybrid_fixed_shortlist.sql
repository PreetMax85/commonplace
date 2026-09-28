-- Hybrid search sized each side's shortlist from match_count, so asking for
-- fewer results also changed their order: the app asks for 8 and merged two
-- lists of 16, while the eval asks for 10 and merged two lists of 20. On the
-- eval questions, half of the app's top 8 came back in a different order from
-- the one the eval measured. Each list now holds at least 20 candidates, so
-- the order no longer depends on how many results are asked for, up to 10.
--
-- Same signature as before, so the grants from migration 0007 still apply.
--
-- Safe to run more than once.
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
    limit greatest(least(match_count, 30) * 2, 20)
  ),
  keyword as (
    select
      chunks.id,
      row_number() over (order by ts_rank(chunks.fts, query.q) desc, chunks.id) as rank_ix
    from chunks, query
    where chunks.notebook_id = match_notebook_id
      and chunks.fts @@ query.q
    order by rank_ix
    limit greatest(least(match_count, 30) * 2, 20)
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
