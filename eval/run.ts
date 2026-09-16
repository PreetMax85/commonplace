// Measures retrieval quality on the labelled question set.
//
// This calls the same embedding function and the same match_chunks RPC that
// /api/query calls, with the notebook's questions asked one at a time. It stops
// before the answer is written, because generating prose does not change which
// chunks were retrieved. No Groq request is made and no API route is touched,
// so a run costs nothing and spends none of the public demo's daily budget.
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

interface Result {
  id: string;
  fact: string;
  phrasing: string;
  question: string;
  rank: number | null;
  returned: { rank: number; source: string; locator: string; similarity: number; snippet: string }[];
}

const results: Result[] = [];

for (const q of set.questions) {
  const fact = set.facts[q.fact];
  const embedding = await embedText(q.question);
  const { data: matches, error } = await supabaseAdmin.rpc("match_chunks", {
    query_embedding: embedding,
    match_notebook_id: set.notebook_id,
    match_count: set.match_count,
  });
  if (error) throw error;

  const wantedSource = byTitle.get(fact.source)!;
  const rows = (matches ?? []) as (Chunk & { similarity: number })[];
  const index = rows.findIndex(
    (m) => m.source_id === wantedSource && matchingChunks(fact, m)
  );

  results.push({
    id: q.id,
    fact: q.fact,
    phrasing: q.phrasing,
    question: q.question,
    rank: index === -1 ? null : index + 1,
    returned: rows.map((m, i) => ({
      rank: i + 1,
      source: titleById.get(m.source_id) ?? m.source_id,
      locator: describe(m.metadata),
      similarity: Number(m.similarity.toFixed(4)),
      snippet: m.content.slice(0, 120),
    })),
  });
  process.stdout.write(index === -1 ? "x" : index + 1 === 10 ? "+" : String(index + 1));
}
process.stdout.write("\n\n");

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
const bySource: Record<string, ReturnType<typeof score>> = {};
for (const title of new Set(Object.values(set.facts).map((f) => f.source))) {
  const rows = results.filter((r) => set.facts[r.fact].source === title);
  bySource[title] = score(rows);
}

const report = {
  run_at: new Date().toISOString(),
  commit,
  notebook_id: set.notebook_id,
  sources: sources?.length ?? 0,
  chunks: chunkCount ?? 0,
  embedding_model: EMBED_MODEL,
  match_count: set.match_count,
  overall: score(results),
  verbatim: score(results.filter((r) => r.phrasing === "verbatim")),
  reworded: score(results.filter((r) => r.phrasing === "reworded")),
  by_source: bySource,
  results,
};

// Minute-stamped rather than dated, so a second run never quietly replaces the
// first and two runs can be compared in the repo.
const stamp = report.run_at.slice(0, 16).replace(/[:T]/g, "-");
const out = join(import.meta.dirname, "results", `${stamp}.json`);
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

for (const [label, s] of [["overall", report.overall], ["verbatim", report.verbatim], ["reworded", report.reworded]] as const) {
  console.log(
    `${label.padEnd(9)} n=${s.questions}  hit@1 ${s["hit@1"].toFixed(2)}  hit@5 ${s["hit@5"].toFixed(2)}  hit@8 ${s["hit@8"].toFixed(2)}  MRR@10 ${s["mrr@10"].toFixed(3)}`
  );
}

console.log("\nhit@5 by source:");
for (const [title, s] of Object.entries(bySource)) {
  console.log(`  ${String(Math.round(s["hit@5"] * s.questions)).padStart(2)}/${s.questions}  ${title}`);
}

const misses = results.filter((r) => r.rank === null);
if (misses.length) {
  console.log(`\nnot found in the top ${set.match_count}:`);
  for (const m of misses) console.log(`  ${m.phrasing.padEnd(8)} ${m.question}`);
}
console.log(`\nwritten to ${out}`);
