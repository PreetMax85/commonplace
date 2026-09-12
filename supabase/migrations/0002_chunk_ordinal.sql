-- Adds an explicit reading-order key to chunks.
--
-- The source viewer used to order by metadata->chunk_index, which is wrong for
-- every source type: the PDF extractor restarts chunk_index at 0 on each page,
-- so pages interleaved, and the YouTube and VTT extractors never set it at all,
-- so their chunks came back in whatever order the database chose. Ingest now
-- assigns ordinal as the position of the chunk within its source.
--
-- Existing rows are deliberately left at 0 rather than backfilled. Order cannot
-- be reconstructed after the fact: chunks are inserted in batches and every row
-- in a batch shares one created_at, so any backfill would be sorting by primary
-- key inside each batch, which is a random ordering wearing a convincing hat.
-- Re-index a source from the app to give its chunks real ordinals.
--
-- Safe to run more than once.

begin;

alter table chunks add column if not exists ordinal int not null default 0;

create index if not exists chunks_source_ordinal_idx on chunks(source_id, ordinal);

commit;
