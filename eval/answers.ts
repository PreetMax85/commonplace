// Measures whether answers cite the passage that actually answers the question.
//
// eval/run.ts stops at retrieval. This goes one step further: each question is
// answered by the same search and the same answer call as /api/query, with the
// same number of passages, and the citations in the answer are checked against
// the labels in questions.json. A question whose answering passage was never
// retrieved cannot be cited correctly, so the headline rate only counts the
// questions where it was.
//
// Unlike run.ts this spends Groq tokens, from the same free tier budget as the
// live demo: roughly 3,500 per question, about 140,000 for the full set against
// a 200,000 daily cap. Progress is written after every question, and
// `--resume <file>` continues a run that stopped partway.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { supabaseAdmin } from "../src/lib/supabase.ts";
import { embedText, streamAnswer, EMBED_MODEL, LLM_MODEL, ANSWER_PASSAGES } from "../src/lib/llm.ts";
import { checkCitations } from "../src/lib/citations.ts";
import { loadSet, resolveSources, matchingChunks, type Chunk, type Question } from "./lib.ts";

const set = loadSet();
const commit = execSync("git rev-parse --short HEAD").toString().trim();

const { data: sources, error: srcErr } = await supabaseAdmin
  .from("sources")
  .select("id,title")
  .eq("notebook_id", set.notebook_id);
if (srcErr) throw srcErr;
const byTitle = resolveSources(set, sources ?? []);
const titleById = new Map((sources ?? []).map((s) => [s.id, s.title]));

interface Result {
  id: string;
  phrasing: Question["phrasing"];
  question: string;
  // Where the answering passage sat among the passages the model was given,
  // null when none of them carries it.
  rank: number | null;
  answer: string;
  cited: number[];
  out_of_range: number[];
  markers: number;
  // Whether any citation points at a passage that carries the labelled answer.
  cites_answer: boolean;
  // A rough reading of whether the answer said the sources do not cover the
  // question. Only reported for retrieval misses, where it is read by hand.
  says_not_found: boolean;
  passages: { n: number; source: string; answers: boolean; snippet: string }[];
}

const resumeIndex = process.argv.indexOf("--resume");
const resumePath = resumeIndex === -1 ? null : process.argv[resumeIndex + 1];
if (resumePath && !existsSync(resumePath)) throw new Error(`No such file: ${resumePath}`);

const previous = resumePath ? JSON.parse(readFileSync(resumePath, "utf8")) : null;
const results: Result[] = previous?.results ?? [];
const done = new Set(results.map((r) => r.id));

const runAt = previous?.run_at ?? new Date().toISOString();
const out =
  resumePath ?? join(import.meta.dirname, "results", `answers-${runAt.slice(0, 16).replace(/[:T]/g, "-")}.json`);

const NOT_FOUND =
  /\b(does not|doesn't|do not|don't) (contain|mention|provide|include|say|address|cover)|not (found|mentioned|covered|addressed) in|no (information|mention)|cannot (find|answer)|isn't (in|covered)/i;

// The free tier allows 8,000 tokens a minute, so a full run is paced by rate
// limit responses. A wait longer than this means the daily cap, which no
// amount of waiting within the run will fix.
const MAX_WAIT_SECONDS = 120;

class DailyLimit extends Error {}

async function answer(question: string, passages: Chunk[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      let text = "";
      for await (const token of streamAnswer(question, passages)) text += token;
      return text;
    } catch (err: any) {
      const limited = err?.status === 429 || /rate.?limit/i.test(err?.message ?? "");
      if (!limited || attempt >= 6) throw err;
      const header = err?.headers?.get?.("retry-after") ?? err?.headers?.["retry-after"];
      const wait = Number(header) || 30;
      if (wait > MAX_WAIT_SECONDS) throw new DailyLimit(`Groq asked to wait ${wait}s`);
      process.stdout.write(`(waiting ${wait}s)`);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
    }
  }
}

function summarize(rows: Result[]) {
  const retrieved = rows.filter((r) => r.rank !== null);
  const rate = (k: number, n: number) => (n ? Number((k / n).toFixed(4)) : null);
  const cited = retrieved.filter((r) => r.cites_answer).length;
  return {
    questions: rows.length,
    answer_retrieved: retrieved.length,
    cited_answer: cited,
    cited_answer_rate: rate(cited, retrieved.length),
  };
}

function report(complete: boolean) {
  const misses = results.filter((r) => r.rank === null);
  const markers = results.reduce((sum, r) => sum + r.markers, 0);
  const summary = {
    overall: summarize(results),
    verbatim: summarize(results.filter((r) => r.phrasing === "verbatim")),
    reworded: summarize(results.filter((r) => r.phrasing === "reworded")),
    no_citations: results.filter((r) => r.markers === 0).length,
    markers,
    // Counted by distinct number per answer, so [9] written twice counts once.
    out_of_range: results.reduce((sum, r) => sum + r.out_of_range.length, 0),
    answers_with_out_of_range: results.filter((r) => r.out_of_range.length > 0).length,
    retrieval_misses: misses.length,
    misses_saying_not_found_rough: misses.filter((r) => r.says_not_found).length,
  };
  writeFileSync(
    out,
    JSON.stringify(
      {
        run_at: runAt,
        complete,
        commit,
        notebook_id: set.notebook_id,
        embedding_model: EMBED_MODEL,
        answer_model: LLM_MODEL,
        passages: ANSWER_PASSAGES,
        summary,
        results,
      },
      null,
      2
    ) + "\n"
  );
  return summary;
}

let stopped: string | null = null;
for (const q of set.questions) {
  if (done.has(q.id)) continue;
  const fact = set.facts[q.fact];
  const wantedSource = byTitle.get(fact.source)!;

  const embedding = await embedText(q.question);
  const { data, error } = await supabaseAdmin.rpc("match_chunks_hybrid", {
    query_text: q.question,
    query_embedding: embedding,
    match_notebook_id: set.notebook_id,
    match_count: ANSWER_PASSAGES,
  });
  if (error) throw new Error(`hybrid search failed: ${error.message}`);
  const rows = (data ?? []) as Chunk[];
  const answering = rows.map((m) => m.source_id === wantedSource && matchingChunks(fact, m));

  let text: string;
  try {
    text = await answer(q.question, rows);
  } catch (err) {
    if (!(err instanceof DailyLimit)) throw err;
    stopped = err.message;
    break;
  }

  const check = checkCitations(text, rows.length);
  const firstAnswering = answering.indexOf(true);
  results.push({
    id: q.id,
    phrasing: q.phrasing,
    question: q.question,
    rank: firstAnswering === -1 ? null : firstAnswering + 1,
    answer: text,
    cited: check.valid,
    out_of_range: check.outOfRange,
    markers: check.markers,
    cites_answer: check.valid.some((n) => answering[n - 1]),
    says_not_found: NOT_FOUND.test(text),
    passages: rows.map((m, i) => ({
      n: i + 1,
      source: titleById.get(m.source_id) ?? m.source_id,
      answers: answering[i],
      snippet: m.content.slice(0, 120),
    })),
  });
  report(false);
  process.stdout.write(".");
}
process.stdout.write("\n\n");

const complete = results.length === set.questions.length;
const summary = report(complete);

for (const label of ["overall", "verbatim", "reworded"] as const) {
  const s = summary[label];
  console.log(
    `${label.padEnd(9)} n=${s.questions}  answer retrieved ${s.answer_retrieved}, cited it ${s.cited_answer} (${s.cited_answer_rate ?? "-"})`
  );
}
console.log(`\nanswers with no citation: ${summary.no_citations}`);
console.log(`markers ${summary.markers}, out of range ${summary.out_of_range} in ${summary.answers_with_out_of_range} answers`);

const uncited = results.filter((r) => r.rank !== null && !r.cites_answer);
if (uncited.length) {
  console.log("\nanswer retrieved but not cited (rank, cited):");
  for (const r of uncited) console.log(`  ${String(r.rank).padStart(2)}  [${r.cited.join(",")}]  ${r.question}`);
}

const misses = results.filter((r) => r.rank === null);
if (misses.length) {
  console.log(`\nretrieval misses, to read by hand (${summary.misses_saying_not_found_rough} look like "not in the sources"):`);
  for (const m of misses) console.log(`  ${m.says_not_found ? "nf" : "  "}  ${m.question}`);
}

if (stopped) console.log(`\nStopped early: ${stopped}. Continue later with --resume ${out}`);
else if (!complete) console.log(`\nIncomplete. Continue with --resume ${out}`);
console.log(`\nwritten to ${out}`);
