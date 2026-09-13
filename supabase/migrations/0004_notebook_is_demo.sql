-- Marks a notebook as the public demo.
--
-- The app has no auth, so every visitor can call every route. The demo
-- notebook is the first thing a visitor opens, and one click on delete or
-- re-index would empty it for everyone after them. Re-index is the subtler
-- risk: it re-fetches YouTube transcripts, which cloud IPs are usually blocked
-- from, so on the deployed site it would wipe the chunks and fail to restore
-- them. The API refuses destructive changes to notebooks with this flag set.
--
-- Safe to run more than once.

alter table notebooks
  add column if not exists is_demo boolean not null default false;
