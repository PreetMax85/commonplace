# Retrieval eval

Search quality is the part of this app that a demo cannot show you. An answer
that reads well can still be built on the wrong passage. This directory measures
how often the search step actually returns the passage that answers the
question, on a fixed set of questions with known answers.

## The numbers, as of 2026-09-16

40 questions against the demo notebook: 9 sources, 903 chunks, commit `d15e3e9`.

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

One source is responsible for most of the failures. The scanned Meditations
edition is 441 of the 903 chunks and scores 2 of 8, while the other eight
sources together score 27 of 32. Looking at what came back instead, the losing
chunks are usually the translator's introduction or a page carrying little more
than the running header, which are close to the query in a general "stoicism"
sense without answering anything. Every one of the ten misses is a real
retrieval failure, not a mislabelled question: the chunks returned do not
contain the answer.

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

A label names a source plus a passage, never a chunk ID, so it stays valid when
chunk boundaries move.

- **Documents and web pages** use a short quote. The chunker overlaps
  consecutive chunks by 150 characters, so any quote shorter than that is
  guaranteed to sit whole inside at least one chunk wherever the boundaries
  fall. A chunk counts as correct when its text contains the quote.
- **Transcripts** use a time window, because they are split by time rather than
  by character count. A chunk counts as correct when its window overlaps the
  labelled one.

Each label also records a human-readable locator, such as `page 72, Book IV.3`
or `43:51 to 44:53`, so any question can be checked against the original.

`npm run eval:check` verifies that every label still matches real text and
prints how many chunks each one resolves to. All 20 resolve to between 1 and 3
chunks.

## Reproducing it

```
npm run eval:check   # confirm the 20 labels still point at real passages
npm run eval         # run the 40 questions, write a dated file to results/
```

The runner calls the same `embedText` and the same `match_chunks` database
function that `/api/query` calls, with the same arguments. It stops before the
answer is generated, because writing prose does not change which chunks were
retrieved. No language model request is made and no API route is touched, so a
run costs nothing and spends none of the public demo's daily budget.

Every run writes a dated file to `results/` holding the settings, the per
question rank, and the top three chunks returned for each question. The failures
are committed along with the successes, so the misses above can be inspected
rather than taken on trust.

Two runs of the same 40 questions against the same index returned the same rank
for every question, so a change in these numbers means a change in the system
and not run to run noise.

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

## Why it exists now

The next two changes to this repo are a swap of the embedding library and the
addition of keyword search alongside vector search. Both could change retrieval
quality without anything visibly breaking. These numbers are the before.
