-- Gives every notebook an owner, so each visitor sees only their own.
--
-- Visitors become Supabase anonymous users the first time they create a
-- notebook, with no signup form. The demo notebook has no owner and stays
-- readable by everyone. Deleting a user deletes their notebooks, which cascades
-- to sources and chunks.
--
-- The browser now holds the project's publishable key, which anyone can copy
-- and use to query the database directly. All reads and writes go through the
-- API with the service-role key, which bypasses row level security, so
-- enabling RLS with no policies closes that path without changing the app.
--
-- Safe to run more than once.

alter table notebooks
  add column if not exists owner_id uuid references auth.users(id) on delete cascade;

create index if not exists notebooks_owner_idx on notebooks(owner_id);

alter table notebooks enable row level security;
alter table sources enable row level security;
alter table chunks enable row level security;

-- Functions are executable by everyone by default. These two run as the
-- caller, so RLS would already return nothing, but only the server needs them.
revoke execute on function match_chunks(vector, uuid, int) from public, anon, authenticated;
grant execute on function match_chunks(vector, uuid, int) to service_role;
revoke execute on function match_chunks_hybrid(text, vector, uuid, int, int) from public, anon, authenticated;
grant execute on function match_chunks_hybrid(text, vector, uuid, int, int) to service_role;

-- Anonymous users are never removed by Supabase itself. The daily cron calls
-- this to find visitors past the retention window, deletes their stored files,
-- then deletes the users. It reads auth.users, which the API cannot query, so
-- it runs as its owner and only the service role may call it.
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
