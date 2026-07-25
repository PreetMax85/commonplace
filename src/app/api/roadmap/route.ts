import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getLLM } from "@/lib/gemini";

// Bonus feature: given the YouTube sources already ingested into a notebook,
// ask the LLM to synthesize an ordered concept roadmap, each step pointing
// back at the specific video + timestamp range where it's taught.
export async function POST(req: NextRequest) {
  const { notebookId } = await req.json();

  const { data: youtubeSources, error } = await supabaseAdmin
    .from("sources")
    .select("id, title, raw_ref")
    .eq("notebook_id", notebookId)
    .eq("type", "youtube")
    .eq("status", "ready");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!youtubeSources || youtubeSources.length === 0) {
    return NextResponse.json(
      { error: "No indexed YouTube sources in this notebook yet" },
      { status: 404 }
    );
  }

  const { data: chunks } = await supabaseAdmin
    .from("chunks")
    .select("source_id, content, metadata")
    .in(
      "source_id",
      youtubeSources.map((s) => s.id)
    );

  const bySource = youtubeSources.map((s) => ({
    title: s.title,
    source_id: s.id,
    videoId: s.raw_ref,
    transcript: (chunks || [])
      .filter((c) => c.source_id === s.id)
      .map((c) => `[${c.metadata.timestamp_start}s-${c.metadata.timestamp_end}s] ${c.content}`)
      .join("\n"),
  }));

  const prompt = `You are building a personalized learning roadmap from these video transcripts.
For each distinct concept taught across the videos, produce a roadmap step in this exact JSON shape:
{ "steps": [ { "concept": string, "why": string, "source_id": string, "timestamp_start": number, "timestamp_end": number } ] }
Order steps from foundational to advanced. Ground every step in an actual transcript segment —
do not invent concepts that aren't in the transcripts. Return ONLY valid JSON, no markdown fences.

Videos:
${bySource.map((s) => `### ${s.title} (source_id: ${s.source_id})\n${s.transcript}`).join("\n\n")}
`;

  const model = getLLM();
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();

  try {
    const parsed = JSON.parse(text.replace(/^```json|```$/g, "").trim());
    return NextResponse.json(parsed);
  } catch {
    return NextResponse.json({ error: "Model returned invalid JSON", raw: text }, { status: 502 });
  }
}
