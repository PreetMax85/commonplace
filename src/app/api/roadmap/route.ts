import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getGroq, LLM_MODEL } from "@/lib/llm";

// Bonus feature: given the YouTube sources already ingested into a notebook,
// ask the LLM to synthesize an ordered concept roadmap, each step pointing
// back at the specific video + timestamp range where it's taught.
export async function POST(req: NextRequest) {
  try {
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

    const validSources = bySource.filter((s) => s.transcript.trim().length > 0);
    if (validSources.length === 0) {
      return NextResponse.json(
        { error: "No transcript content found in this notebook. Please re-index your YouTube sources." },
        { status: 400 }
      );
    }

    const prompt = `You are building a personalized learning roadmap from these video transcripts.
For each distinct concept taught across the videos, produce a roadmap step.
Order steps from foundational to advanced. Ground every step in an actual transcript segment,
and never invent concepts that are not in the transcripts. Use the source_id of the video the
step comes from, and timestamps that fall inside that video's transcript.

Videos:
${bySource.map((s) => `### ${s.title} (source_id: ${s.source_id})\n${s.transcript}`).join("\n\n")}
`;

    const groq = getGroq();
    const response = await groq.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      reasoning_effort: "low",
      // Strict schema means the model cannot emit prose, fences or a stray key,
      // so the response parses without any clean-up guesswork on our side.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "roadmap",
          strict: true,
          schema: {
            type: "object",
            properties: {
              steps: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    concept: { type: "string" },
                    why: { type: "string" },
                    source_id: { type: "string" },
                    timestamp_start: { type: "number" },
                    timestamp_end: { type: "number" },
                  },
                  required: ["concept", "why", "source_id", "timestamp_start", "timestamp_end"],
                  additionalProperties: false,
                },
              },
            },
            required: ["steps"],
            additionalProperties: false,
          },
        },
      },
    });

    const text = response.choices[0]?.message?.content?.trim() || "";
    return NextResponse.json(JSON.parse(text));
  } catch (err: any) {
    console.error("Roadmap generation error:", err);
    return NextResponse.json(
      { error: err?.message || "Failed to generate roadmap" },
      { status: 500 }
    );
  }
}

