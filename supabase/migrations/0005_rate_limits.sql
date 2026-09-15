-- Fixed-window request counters for the public API.
--
-- The app has no auth and every answer spends the Groq free tier, which is a
-- single budget shared by every visitor (8k tokens a minute, 200k a day). One
-- person looping on the query route would break the demo for everyone else,
-- so the routes that call Groq or start an ingest count requests here, per IP
-- and site-wide, and refuse with a 429 once a window is full.
--
-- Safe to run more than once.

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
