// Verifies that every gold label in questions.json still points at real text in
// the notebook. Run it after any re-index: if chunking changes, the quote and
// timestamp anchors should survive, and this is what proves they did.
import { supabaseAdmin } from "../src/lib/supabase.ts";
import { loadSet, resolveSources, matchingChunks, type Chunk } from "./lib.ts";

const set = loadSet();

const { data: sources, error: srcErr } = await supabaseAdmin
  .from("sources")
  .select("id,title")
  .eq("notebook_id", set.notebook_id);
if (srcErr) throw srcErr;

const byTitle = resolveSources(set, sources ?? []);

const { data: chunks, error: chunkErr } = await supabaseAdmin
  .from("chunks")
  .select("id,source_id,content,metadata")
  .eq("notebook_id", set.notebook_id)
  .limit(5000);
if (chunkErr) throw chunkErr;

let problems = 0;
for (const [factId, fact] of Object.entries(set.facts)) {
  const sourceId = byTitle.get(fact.source)!;
  const hits = (chunks as Chunk[]).filter(
    (c) => c.source_id === sourceId && matchingChunks(fact, c)
  );
  const ordinals = hits.map((h) => h.metadata.chunk_index ?? h.metadata.timestamp_start).join(", ");
  const flag = hits.length === 0 ? "EMPTY" : hits.length > 4 ? "BROAD" : "ok";
  if (flag !== "ok") problems++;
  console.log(
    `${flag.padEnd(5)} ${factId.padEnd(28)} ${String(hits.length).padStart(2)} chunk(s)  [${ordinals}]`
  );
}

console.log(
  `\n${Object.keys(set.facts).length} labels checked, ${problems} needing attention.`
);
process.exit(problems === 0 ? 0 : 1);
