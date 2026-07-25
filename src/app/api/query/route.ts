import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { embedText, streamAnswer, condenseQuestion, ChatTurn } from "@/lib/gemini";
import { TaskType } from "@google/generative-ai";

export async function POST(req: NextRequest) {
  const { notebookId, question, history } = await req.json();
  if (!notebookId || !question) {
    return new Response(JSON.stringify({ error: "notebookId and question required" }), {
      status: 400,
    });
  }

  const chatHistory: ChatTurn[] = Array.isArray(history) ? history : [];

  // Retrieval runs on a standalone-ified version of the question so
  // follow-ups ("what about the second one?") embed something searchable —
  // the LLM answer still sees the raw question + full recent history.
  const retrievalQuestion = await condenseQuestion(question, chatHistory);
  const queryEmbedding = await embedText(retrievalQuestion, TaskType.RETRIEVAL_QUERY);

  // Notebook isolation enforced here via match_notebook_id filter — a
  // chunk from another notebook can never surface in this search.
  const { data: matches, error } = await supabaseAdmin.rpc("match_chunks", {
    query_embedding: queryEmbedding,
    match_notebook_id: notebookId,
    match_count: 8,
  });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
  if (!matches || matches.length === 0) {
    return new Response(
      JSON.stringify({ error: "No indexed sources found in this notebook yet" }),
      { status: 404 }
    );
  }

  // Stream the answer as SSE-style chunks, then send the citation map so
  // the frontend can render [n] as clickable source-viewer links.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: citations\ndata: ${JSON.stringify(
            matches.map((m: any, i: number) => ({
              n: i + 1,
              source_id: m.source_id,
              metadata: m.metadata,
              snippet: m.content.slice(0, 160),
            }))
          )}\n\n`
        )
      );

      for await (const token of streamAnswer(question, matches, chatHistory)) {
        controller.enqueue(encoder.encode(`event: token\ndata: ${JSON.stringify(token)}\n\n`));
      }

      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
