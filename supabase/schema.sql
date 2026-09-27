-- Enable pgvector
create extension if not exists vector;

create table if not exists notebooks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_demo boolean not null default false, -- public demo, protected from delete and re-index
  owner_id uuid references auth.users(id) on delete cascade, -- null only for the demo
  created_at timestamptz default now()
);

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid references notebooks(id) on delete cascade,
  type text not null check (type in ('pdf','text','url','youtube','vtt')),
  title text not null,
  raw_ref text,               -- storage path, url, or youtube video id
  status text not null default 'uploading' check (status in ('uploading','indexing','ready','error')),
  error_message text,
  created_at timestamptz default now(),
  updated_at timestamptz default now() -- last status change, used to spot stalled indexing
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references sources(id) on delete cascade,
  notebook_id uuid references notebooks(id) on delete cascade, -- denormalized for fast filtered search
  content text not null,
  metadata jsonb not null default '{}', -- {page, timestamp_start, timestamp_end, section, chunk_index}
  ordinal int not null default 0, -- position within the source, assigned at ingest
  embedding vector(384), -- bge-small-en-v1.5, computed locally via Transformers.js
  created_at timestamptz default now()
);

-- Vector similarity index. HNSW rather than ivfflat: an ivfflat index built
-- before any rows exist picks its centroids from an empty table, and every
-- later search then probes one badly placed list, so real matches get missed.
-- HNSW builds incrementally and needs no representative training data.
create index if not exists chunks_embedding_idx on chunks
  using hnsw (embedding vector_cosine_ops);

create index if not exists chunks_notebook_idx on chunks(notebook_id);
create index if not exists chunks_source_ordinal_idx on chunks(source_id, ordinal);
create index if not exists sources_notebook_idx on sources(notebook_id);
create index if not exists notebooks_owner_idx on notebooks(owner_id);

-- The browser holds the publishable key, which anyone can use to query the
-- database directly. The API uses the service-role key, which bypasses RLS, so
-- RLS with no policies closes the direct path without affecting the app.
alter table notebooks enable row level security;
alter table sources enable row level security;
alter table chunks enable row level security;

-- RPC for filtered vector search (notebook isolation happens here)
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

-- Keyword search column and index (see migration 0006).
alter table chunks
  add column if not exists fts tsvector
  generated always as (to_tsvector('english', content)) stored;

create index if not exists chunks_fts_idx on chunks using gin (fts);

-- RPC for hybrid search: vector and keyword results merged by reciprocal rank
-- fusion (see migration 0006 for why each choice was made).
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

-- Fixed-window request counters for the public API (see migration 0005).
create table if not exists rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Only the server's service-role client touches this table. RLS with no
-- policies keeps it unreadable through the anon key.
alter table rate_limits enable row level security;

-- Counts one request against every rule passed in, in one transaction.
-- A request is allowed only if it fits all of them. A refused request is not
-- counted, so hitting the site-wide limit does not also use up a visitor's own
-- allowance. Rules are locked in key order so two concurrent calls cannot
-- deadlock on the same rows.
--
-- Returns whether the request is allowed and, when it is not, which rule
-- refused it and how many seconds until that window resets.
create or replace function hit_rate_limits(
  p_keys text[],
  p_windows integer[],
  p_limits integer[]
)
returns table (allowed boolean, blocked_key text, retry_after integer)
language plpgsql
set search_path = public
as $$
declare
  i integer;
  v_now timestamptz := now();
  v_start timestamptz;
  v_count integer;
  v_starts timestamptz[] := '{}';
  v_retry integer;
  v_blocked_key text := null;
  v_blocked_retry integer := 0;
begin
  if cardinality(p_keys) <> cardinality(p_windows) or cardinality(p_keys) <> cardinality(p_limits) then
    raise exception 'hit_rate_limits: keys, windows and limits must have the same length';
  end if;

  for i in select idx from generate_subscripts(p_keys, 1) as idx order by p_keys[idx] loop
    v_start := to_timestamp(floor(extract(epoch from v_now) / p_windows[i]) * p_windows[i]);
    v_starts[i] := v_start;

    insert into rate_limits as r (key, window_start, count)
    values (p_keys[i], v_start, 1)
    on conflict (key, window_start) do update set count = r.count + 1
    returning r.count into v_count;

    if v_count > p_limits[i] then
      v_retry := greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_windows[i]) - v_now)))::integer);
      if v_retry > v_blocked_retry then
        v_blocked_key := p_keys[i];
        v_blocked_retry := v_retry;
      end if;
    end if;
  end loop;

  if v_blocked_key is not null then
    for i in 1 .. cardinality(p_keys) loop
      update rate_limits set count = count - 1
      where key = p_keys[i] and window_start = v_starts[i];
    end loop;
  end if;

  return query select v_blocked_key is null, v_blocked_key, v_blocked_retry;
end;
$$;

revoke execute on function hit_rate_limits(text[], integer[], integer[]) from public, anon, authenticated;
grant execute on function hit_rate_limits(text[], integer[], integer[]) to service_role;

-- Search functions are for the server only.
revoke execute on function match_chunks(vector, uuid, int) from public, anon, authenticated;
grant execute on function match_chunks(vector, uuid, int) to service_role;
revoke execute on function match_chunks_hybrid(text, vector, uuid, int, int) from public, anon, authenticated;
grant execute on function match_chunks_hybrid(text, vector, uuid, int, int) to service_role;

-- Anonymous visitors past the retention window. Supabase never removes
-- anonymous users itself, so the daily cron deletes their files and then the
-- users, which cascades to their notebooks.
create or replace function expired_anonymous_users(max_age interval)
returns setof uuid
language sql
security definer
set search_path = ''
as $$
  select id from auth.users
  where is_anonymous is true and created_at < now() - max_age;
$$;

revoke execute on function expired_anonymous_users(interval) from public, anon, authenticated;
grant execute on function expired_anonymous_users(interval) to service_role;

-- Space taken by sources (migration 0008), so a new source can be refused before
-- the free plan's Storage or database runs out.
create or replace function space_used(for_owner uuid default null)
returns table (file_bytes bigint, chunk_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select coalesce(sum((o.metadata->>'size')::bigint), 0)
       from storage.objects o
      where o.bucket_id = 'sources'
        and (for_owner is null or split_part(o.name, '/', 1) in (
          select n.id::text from public.notebooks n where n.owner_id = for_owner))),
    (select count(*)
       from public.chunks c
      where for_owner is null or c.notebook_id in (
        select n.id from public.notebooks n where n.owner_id = for_owner));
$$;

revoke execute on function space_used(uuid) from public, anon, authenticated;
grant execute on function space_used(uuid) to service_role;

-- Files uploaded straight from the browser that never became a source, such
-- as an upload abandoned halfway. The daily cron removes them.
create or replace function unregistered_uploads(max_age interval)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'sources'
     and o.created_at < now() - max_age
     and not exists (select 1 from public.sources s where s.raw_ref = o.name);
$$;

revoke execute on function unregistered_uploads(interval) from public, anon, authenticated;
grant execute on function unregistered_uploads(interval) to service_role;
