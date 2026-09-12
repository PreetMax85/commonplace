-- Adds a last-changed timestamp to sources.
--
-- Ingestion runs in the background after the upload response is sent. If that
-- work dies partway through, most likely by exhausting the function's time
-- budget on a very long document, it takes its own error handling with it and
-- the source reads "indexing" forever. created_at cannot distinguish that from
-- a source that was simply uploaded a long time ago and re-indexed a minute
-- ago, so status transitions are stamped separately.
--
-- Existing rows start at now(), which means a source already stuck before this
-- migration gets one more full window before it is swept. That is the right
-- trade: it errs towards patience rather than failing live work.
--
-- Safe to run more than once.

begin;

alter table sources add column if not exists updated_at timestamptz default now();

update sources set updated_at = created_at where updated_at is null;

commit;
