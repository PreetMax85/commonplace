import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { embedText, streamAnswer, condenseQuestion, describeGroqError, ChatTurn } from "@/lib/llm";
import { enforceRateLimit } from "@/lib/rateLimit";

const MAX_QUESTION_CHARS = 1000;
const MAX_HISTORY_TURNS = 6;
const MAX_TURN_CHARS = 1500;

export async function POST(req: NextRequest) {
  const { notebookId, question, history } = await req.json();
  if (!notebookId || !question) {
    return new Response(JSON.stringify({ error: "notebookId and question required" }), {
      status: 400,
    });
  }

  if (typeof question !== "string" || question.length > MAX_QUESTION_CHARS) {
    return new Response(
      JSON.stringify({ error: `Questions can be up to ${MAX_QUESTION_CHARS} characters.` }),
      { status: 400 }
    );
  }

  // Checked before the rate limit so asking a notebook that is still indexing
  // does not use up a question.
  const { data: anyChunk, error: chunkError } = await supabaseAdmin
    .from("chunks")
    .select("id")
    .eq("notebook_id", notebookId)
    .limit(1);
  if (chunkError) {
    return new Response(JSON.stringify({ error: chunkError.message }), { status: 500 });
  }
  if (!anyChunk?.length) {
    return new Response(
      JSON.stringify({ error: "No indexed sources found in this notebook yet" }),
      { status: 404 }
    );
  }

  const limited = await enforceRateLimit(req, "query");
  if (limited) return limited;

  // The rate limit counts requests, not tokens, and history comes straight from
  // the client. Keeping only the recent turns and bounding each one keeps a
  // single request inside the free tier's per-minute token budget.
  const chatHistory: ChatTurn[] = (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY_TURNS)
    .map((h: any) => ({
      role: h?.role === "assistant" ? "assistant" : "user",
      content: String(h?.content ?? "").slice(0, MAX_TURN_CHARS),
    }));

  // Retrieval runs on a standalone-ified version of the question so
  // follow-ups ("what about the second one?") embed something searchable —
  // the LLM answer still sees the raw question + full recent history.
  const retrievalQuestion = await condenseQuestion(question, chatHistory);
  const queryEmbedding = await embedText(retrievalQuestion);

  // Notebook isolation enforced here via match_notebook_id filter — a
  // chunk from another notebook can never surface in this search.
  // Hybrid search: vector and keyword results merged by rank (migration 0006).
  // On the eval set it found every answer match_chunks found in the top 8, plus
  // two more, and put three more answers first.
  const { data: matches, error } = await supabaseAdmin.rpc("match_chunks_hybrid", {
    query_text: retrievalQuestion,
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
      try {
        controller.enqueue(
          encoder.encode(
            `event: citations\ndata: ${JSON.stringify(
              matches.map((m: any, i: number) => ({
                n: i + 1,
                source_id: m.source_id,
                // The viewer highlights on this. Matching on metadata instead
                // cannot identify a single chunk: two chunks on one PDF page
                // share a page number, and overlapping text chunks share
                // everything but their index.
                chunk_id: m.id,
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
      } catch (err: any) {
        console.error("Stream generation error:", err);
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: describeGroqError(err) })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
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
