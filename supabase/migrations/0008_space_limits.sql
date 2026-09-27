-- Measures the space sources take, so the app can refuse a new one before the
-- free plan's 1 GB of Storage or 500 MB of database runs out. A full database
-- turns read-only, which would take the demo down with it.
--
-- Files live in the "sources" bucket under <notebook id>/, so a file belongs
-- to whoever owns the notebook its folder is named after. Both functions read
-- storage.objects, which the API cannot query, so they run as their owner and
-- only the service role may call them.
--
-- Safe to run more than once.

-- Bytes of stored files and number of chunks, for one visitor or, with no
-- owner, for the whole site.
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
