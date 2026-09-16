# Retrieval eval

Search quality is the part of this app that a demo cannot show you. An answer
that reads well can still be built on the wrong passage. This directory measures
how often the search step actually returns the passage that answers the
question, on a fixed set of questions with known answers.

## The numbers, as of 2026-09-16

40 questions against the demo notebook: 9 sources, 903 chunks, commit `977b8cc`.

| | questions | hit@1 | hit@5 | hit@8 | MRR@10 |
| --- | --- | --- | --- | --- | --- |
| Overall | 40 | 0.35 | 0.72 | 0.75 | 0.500 |
| Word for word | 20 | 0.45 | 0.85 | 0.85 | 0.599 |
| Reworded | 20 | 0.25 | 0.60 | 0.65 | 0.400 |

What the columns mean:

- **hit@1**: how often the very first chunk returned is one that answers the question.
- **hit@5**: how often an answering chunk appears anywhere in the top 5.
- **hit@8**: the same at 8, which is the number of chunks the live app actually
  sends to the model, so this is the figure that matters for answer quality.
- **MRR@10**: how high up the list the answering chunk was, on average. First
  place scores 1, second scores 1/2, third 1/3, and nothing in the top 10 scores 0.

## What the numbers say

Search does well when a question reuses the document's own vocabulary and
noticeably worse when it does not: hit@5 drops from 0.85 to 0.60 on exactly the
same 20 facts, asked in different words. That gap is the argument for adding
keyword matching alongside vector search rather than relying on vectors alone.

For scale, a question whose label is a single chunk has roughly a 1 in 100
chance of being answered by luck in a top 10 of 903 chunks. These numbers are
well clear of that, which is the least that should be true and is worth stating
once rather than assuming.

One source is responsible for most of the failures. The scanned Meditations
edition is 441 of the 903 chunks and scores 2 of 8 at hit@5, while the other
eight sources together score 27 of 32. Looking at what came back instead, the
losing chunks are usually the translator's introduction or a page carrying
little more than the running header, which are close to the query in a general
"stoicism" sense without answering anything. Each results file holds the
per-source split so these figures are computed rather than added up by hand.

None of the ten misses is caused by a mislabelled question: in every case all
ten returned chunks were read, and none carries the labelled passage. That is
a slightly weaker statement than "none of them answers the question", since a
chunk that answers in different words would still score as a miss.

## Hybrid search, 2026-09-16

`match_chunks_hybrid` (migration `0006`) runs keyword search next to vector
search and merges the two ranked lists with reciprocal rank fusion. Both
searches were run on the same 40 questions in one run, commit `ade1358`, file
`results/2026-09-16-11-21.json`.

| | vector hit@1 | hybrid hit@1 | vector hit@8 | hybrid hit@8 | vector MRR@10 | hybrid MRR@10 |
| --- | --- | --- | --- | --- | --- | --- |
| Overall | 0.35 | 0.425 | 0.725 | 0.75 | 0.495 | 0.552 |
| Word for word | 0.45 | 0.60 | 0.80 | 0.85 | 0.589 | 0.722 |
| Reworded | 0.25 | 0.25 | 0.65 | 0.65 | 0.400 | 0.383 |

What this does and does not show:

- The real gain is ranking: three more questions get the answer in first place,
  all of them worded like the source. Reworded questions are unchanged, which is
  expected, since keyword search needs shared words.
- The gain in how many answers are found at all is one or two questions, which
  is within noise on a set this size. Asking for 8 chunks, as the live app
  does, hybrid found every answer vector search found plus two more.
- Vector search alone scores 0.70 at hit@5 here, not the 0.72 above. Adding the
  keyword column rewrote the table and rebuilt the HNSW index, which is
  approximate, and the rebuilt index misses one passage. An exact search over
  the same chunks scores 0.725.
- Meditations went from 2 of 8 to 1 of 8 at hit@5. Its running header ("MARCUS
  AURELIUS") shares words with most questions about it, and its 1000 character
  chunks each hold several unrelated numbered passages, so the answering chunk
  shares few words with the question.

Two follow-ups were tried on a local copy of the same 903 chunks and dropped:

- Weighting rare words above common ones (BM25 style) found one more answer at
  hit@5 and doubled query time. One question is noise, so it was not shipped.
- Stripping page headers and page numbers from the PDFs before chunking changed
  nothing for hybrid search and cost vector search one question.

`/api/query` now calls `match_chunks_hybrid`. `match_chunks` is kept so the
comparison can be rerun.

## How the questions were built

20 facts, each asked twice:

- **word for word**, reusing the distinctive wording of the passage
- **reworded**, asking the same thing while avoiding that wording

Both phrasings of a fact share one gold label, so the difference between the two
columns above is caused by the phrasing and nothing else.

The questions were written by hand after reading the sources. They were not
generated from the chunk text, which would copy its wording into the question
and quietly inflate the score, and they were not written by looking at what
search returned.

## How a gold label survives re-chunking

A label names a source plus a passage rather than a chunk ID, so it stays valid
when chunk boundaries move.

- **Documents and web pages** use a short quote. The chunker overlaps
  consecutive chunks by 150 characters, so any quote shorter than that is
  guaranteed to sit whole inside at least one chunk wherever the boundaries
  fall within a page. PDFs are chunked a page at a time, so a quote must not
  straddle a page break. The longest quote used here is 88 characters. A chunk
  counts as correct when its text contains the quote.
- **Transcripts** use a time window, because they are split by time rather than
  by character count. A chunk counts as correct when its window overlaps the
  labelled one, strictly at both ends, so two windows that meet at a point
  cannot both be credited for one chunk.

Being straight about how the transcript windows were produced: they were read
off the current segmentation, so their endpoints are today's chunk boundaries
expressed in seconds. The label form survives re-chunking, because an overlap
test does not care where the boundaries are, but the specific numbers were not
arrived at independently of them.

Each label also records a human-readable locator, such as `page 72, Book IV.3`
or `43:51 to 44:53`, so any question can be checked against the original.

`npm run eval:check` verifies that every label still matches real text and
prints how many chunks each one resolves to. All 20 resolve to between 1 and 3
chunks.

## Reproducing it

```
npm run eval:check   # confirm the 20 labels still point at real passages
npm run eval         # run the 40 questions, write a timestamped file to results/
npm run typecheck    # typechecks the app and these scripts separately
```

The runner calls the same `embedText` and the same `match_chunks` database
function that `/api/query` calls. It stops before the answer is generated,
because writing prose does not change which chunks were retrieved. No language
model request is made and no API route is touched, so a run spends none of the
public demo's daily budget. The first run on a machine does download the
embedding model, so it needs a network connection even though it costs nothing.

Two deliberate differences from the live route, neither of which affects the
figures above:

- The route asks `match_chunks` for 8 chunks and the eval asks for 10, so that
  MRR@10 has a full window to work with. hit@10 is 0.75, the same as hit@8, so
  no question is rescued by the two extra places.
- The route rewrites a question into standalone form before embedding it when
  there is a prior conversation. Every question here is asked on its own, and
  that step is skipped on an empty history, so first-turn retrieval really is
  the same path. Follow-up questions are therefore not measured at all.

Every run writes a timestamped file to `results/` holding the settings, the
per-source split, and for each question its rank and all ten chunks that came
back. The failures are committed along with the successes, so the misses above
can be inspected rather than taken on trust.

Repeated runs of the same 40 questions against the same index returned the same
rank for every question, so a change in these numbers means a change in the
system rather than run to run noise. That holds while the demo is the only
notebook in the database. `match_chunks` filters by notebook after searching a
shared vector index, so once other notebooks hold enough chunks, the same query
can return a different top 10 with no change to this code.

## Honest limits

- The questions were written by someone who had read the sources. That is a
  normal way to build a small eval set, but it is not the same as questions
  collected from real users.
- 40 questions is small. A five point move in hit@5 is two questions, which is
  within noise. Treat it as a coarse instrument for catching real regressions
  and real improvements, not a precise measurement.
- Reproducing it needs a Supabase project with the demo notebook loaded.
  `corpus.md` lists every source so the notebook can be rebuilt.
- A page-level or window-level label is coarser than pointing at one chunk. A
  time window can span two or three transcript chunks, any of which counts.
  That is the price of labels that survive re-chunking.
- Only single-turn retrieval is measured. The question-rewriting step that runs
  on follow-up questions is untested here.

## Why it exists now

The next two changes to this repo are a swap of the embedding library and the
addition of keyword search alongside vector search. Both could change retrieval
quality without anything visibly breaking. These numbers are the before.
