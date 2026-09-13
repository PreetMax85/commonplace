-- Enable pgvector
create extension if not exists vector;

create table if not exists notebooks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_demo boolean not null default false, -- public demo, protected from delete and re-index
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
