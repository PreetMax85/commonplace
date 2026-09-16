// Measures retrieval quality on the labelled question set.
//
// Every question is asked of two searches: match_chunks, the vector-only search
// the app shipped with, and match_chunks_hybrid, which adds keyword search.
// Both see the same embedding and the same data in the same run, so a
// difference between them comes from the search and nothing else.
//
// It calls the same embedding function as /api/query, with the notebook's
// questions asked one at a time. It stops before the answer is written, because
// generating prose does not change which chunks were retrieved. No Groq request
// is made and no API route is touched, so a run costs nothing and spends none
// of the public demo's daily budget.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { supabaseAdmin } from "../src/lib/supabase.ts";
import { embedText, EMBED_MODEL } from "../src/lib/llm.ts";
import { loadSet, resolveSources, matchingChunks, type Chunk } from "./lib.ts";

const set = loadSet();

// Read before the run: forty embeddings take a while, and a git failure
// afterwards would throw the whole thing away.
const commit = execSync("git rev-parse --short HEAD").toString().trim();

// The metric names below are written out, so a changed window would silently
// mislabel them.
if (set.match_count !== 10) {
  throw new Error(`match_count must be 10 for hit@8 and MRR@10 to mean what they say, got ${set.match_count}`);
}

const { data: sources, error: srcErr } = await supabaseAdmin
  .from("sources")
  .select("id,title")
  .eq("notebook_id", set.notebook_id);
if (srcErr) throw srcErr;
const byTitle = resolveSources(set, sources ?? []);
const titleById = new Map((sources ?? []).map((s) => [s.id, s.title]));

const { count: chunkCount } = await supabaseAdmin
  .from("chunks")
  .select("id", { count: "exact", head: true })
  .eq("notebook_id", set.notebook_id);

const SEARCHES = ["vector", "hybrid"] as const;
type Search = (typeof SEARCHES)[number];

function search(name: Search, question: string, embedding: number[]) {
  const common = {
    query_embedding: embedding,
    match_notebook_id: set.notebook_id,
    match_count: set.match_count,
  };
  return name === "vector"
    ? supabaseAdmin.rpc("match_chunks", common)
    : supabaseAdmin.rpc("match_chunks_hybrid", { query_text: question, ...common });
}

type Row = Chunk & { similarity: number; semantic_rank?: number | null; keyword_rank?: number | null };

interface Result {
  id: string;
  fact: string;
  phrasing: string;
  question: string;
  rank: number | null;
  returned: {
    rank: number;
    chunk_id: string;
    source: string;
    locator: string;
    similarity: number;
    // Hybrid only: where the chunk placed in each list before merging, null
    // when that list did not return it.
    semantic_rank?: number | null;
    keyword_rank?: number | null;
    snippet: string;
  }[];
}

const results: Record<Search, Result[]> = { vector: [], hybrid: [] };

for (const q of set.questions) {
  const fact = set.facts[q.fact];
  const embedding = await embedText(q.question);
  const wantedSource = byTitle.get(fact.source)!;

  for (const name of SEARCHES) {
    const { data: matches, error } = await search(name, q.question, embedding);
    if (error) {
      throw new Error(`${name} search failed: ${error.message}. Has migration 0006 been run?`);
    }

    const rows = (matches ?? []) as Row[];
    const index = rows.findIndex(
      (m) => m.source_id === wantedSource && matchingChunks(fact, m)
    );

    results[name].push({
      id: q.id,
      fact: q.fact,
      phrasing: q.phrasing,
      question: q.question,
      rank: index === -1 ? null : index + 1,
      returned: rows.map((m, i) => ({
        rank: i + 1,
        chunk_id: m.id,
        source: titleById.get(m.source_id) ?? m.source_id,
        locator: describe(m.metadata),
        similarity: Number(m.similarity.toFixed(4)),
        ...(name === "hybrid" && { semantic_rank: m.semantic_rank, keyword_rank: m.keyword_rank }),
        snippet: m.content.slice(0, 120),
      })),
    });
  }
  process.stdout.write(".");
}
process.stdout.write("\n\n");

// The vector half of hybrid search should order chunks exactly as match_chunks
// does. If the planner ever chose the index for one function and a full scan
// for the other, the two would differ and the comparison would be unfair.
for (const [i, hybridResult] of results.hybrid.entries()) {
  const vectorReturned = results.vector[i].returned;
  for (const row of hybridResult.returned) {
    const r = row.semantic_rank;
    if (r != null && r <= vectorReturned.length && vectorReturned[r - 1].chunk_id !== row.chunk_id) {
      throw new Error(`${hybridResult.id}: vector rank ${r} differs between match_chunks and match_chunks_hybrid`);
    }
  }
}

function describe(metadata: Record<string, any>): string {
  if (metadata.page !== undefined) return `page ${metadata.page}`;
  if (metadata.timestamp_start !== undefined) {
    return `${clock(metadata.timestamp_start)} to ${clock(metadata.timestamp_end)}`;
  }
  return `chunk ${metadata.chunk_index}`;
}

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function score(rows: Result[]) {
  const n = rows.length;
  const at = (k: number) => rows.filter((r) => r.rank !== null && r.rank <= k).length / n;
  const mrr = rows.reduce((sum, r) => sum + (r.rank === null ? 0 : 1 / r.rank), 0) / n;
  return {
    questions: n,
    "hit@1": Number(at(1).toFixed(4)),
    "hit@5": Number(at(5).toFixed(4)),
    "hit@8": Number(at(8).toFixed(4)),
    "mrr@10": Number(mrr.toFixed(4)),
  };
}

// Computed rather than worked out by hand for the write-up: the per-source
// split is where a scanned book drags the average down, and arithmetic done in
// prose is arithmetic that goes wrong.
const titles = [...new Set(Object.values(set.facts).map((f) => f.source))];

function summarize(rows: Result[]) {
  const bySource: Record<string, ReturnType<typeof score>> = {};
  for (const title of titles) {
    bySource[title] = score(rows.filter((r) => set.facts[r.fact].source === title));
  }
  return {
    overall: score(rows),
    verbatim: score(rows.filter((r) => r.phrasing === "verbatim")),
    reworded: score(rows.filter((r) => r.phrasing === "reworded")),
    by_source: bySource,
  };
}

const summary = { vector: summarize(results.vector), hybrid: summarize(results.hybrid) };

// Every question whose rank moved, so a better average cannot hide a question
// that got worse.
const changes = results.vector.flatMap((before, i) => {
  const after = results.hybrid[i];
  return before.rank === after.rank
    ? []
    : [{ id: before.id, phrasing: before.phrasing, question: before.question, vector: before.rank, hybrid: after.rank }];
});

const report = {
  run_at: new Date().toISOString(),
  commit,
  notebook_id: set.notebook_id,
  sources: sources?.length ?? 0,
  chunks: chunkCount ?? 0,
  embedding_model: EMBED_MODEL,
  match_count: set.match_count,
  searches: summary,
  changes,
  results,
};

// Minute-stamped rather than dated, so a second run never quietly replaces the
// first and two runs can be compared in the repo.
const stamp = report.run_at.slice(0, 16).replace(/[:T]/g, "-");
const out = join(import.meta.dirname, "results", `${stamp}.json`);
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

const { vector, hybrid } = summary;
const fixed = (x: number, digits = 2) => x.toFixed(digits);
const metrics = ["hit@1", "hit@5", "hit@8", "mrr@10"] as const;

console.log("vector -> hybrid");
for (const label of ["overall", "verbatim", "reworded"] as const) {
  const cells = metrics.map((m) => `${m} ${fixed(vector[label][m], m === "mrr@10" ? 3 : 2)} -> ${fixed(hybrid[label][m], m === "mrr@10" ? 3 : 2)}`);
  console.log(`${label.padEnd(9)} n=${vector[label].questions}  ${cells.join("  ")}`);
}

console.log("\nhit@5 by source:");
for (const title of titles) {
  const found = (s: ReturnType<typeof score>) => String(Math.round(s["hit@5"] * s.questions)).padStart(2);
  const n = vector.by_source[title].questions;
  console.log(`  ${found(vector.by_source[title])}/${n} -> ${found(hybrid.by_source[title])}/${n}  ${title}`);
}

const place = (rank: number | null) => (rank === null ? "miss" : String(rank)).padStart(4);
if (changes.length) {
  console.log("\nrank changes (vector -> hybrid):");
  for (const c of changes) console.log(`  ${place(c.vector)} -> ${place(c.hybrid)}  ${c.phrasing.padEnd(8)} ${c.question}`);
}

const misses = results.hybrid.filter((r) => r.rank === null);
if (misses.length) {
  console.log(`\nhybrid, not found in the top ${set.match_count}:`);
  for (const m of misses) console.log(`  ${m.phrasing.padEnd(8)} ${m.question}`);
}
console.log(`\nwritten to ${out}`);
