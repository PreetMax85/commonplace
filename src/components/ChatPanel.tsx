"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Citation {
  n: number;
  source_id: string;
  metadata: Record<string, any>;
  snippet: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

export default function ChatPanel({
  notebookId,
  onCitationClick,
}: {
  notebookId: string;
  onCitationClick: (citation: Citation) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the latest message, including mid-stream as tokens arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  async function ask() {
    const question = input.trim();
    if (!question || streaming) return;
    setInput("");
    // Snapshot history BEFORE appending the new user turn — this is what
    // the backend uses to resolve follow-up references.
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: question }]);
    setStreaming(true);

    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookId, question, history }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: "Query failed" }));
      setMessages((m) => [...m, { role: "assistant", content: `⚠️ ${err.error}` }]);
      setStreaming(false);
      return;
    }

    let citations: Citation[] = [];
    let answer = "";
    setMessages((m) => [...m, { role: "assistant", content: "", citations: [] }]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const evt of events) {
        const eventMatch = evt.match(/^event: (\w+)/m);
        const dataMatch = evt.match(/^data: (.*)$/m);
        if (!eventMatch || !dataMatch) continue;
        const type = eventMatch[1];
        const data = JSON.parse(dataMatch[1]);

        if (type === "citations") {
          citations = data;
        } else if (type === "token") {
          answer += data;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: answer, citations };
            return copy;
          });
        }
      }
    }

    setStreaming(false);
  }

  return (
    <div className="flex flex-col h-full bg-paper">
      <div className="flex-1 overflow-y-auto space-y-4 p-5">
        {messages.length === 0 && (
          <div className="h-full flex items-center justify-center text-center text-ink-faint text-sm px-8">
            Ask a question about the sources in this notebook. Every answer will cite
            exactly where it came from.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block rounded-lg px-4 py-2.5 max-w-[80%] text-sm leading-relaxed text-left ${
                m.role === "user"
                  ? "bg-accent text-accent-ink"
                  : "bg-paper-raised text-ink border border-line"
              }`}
            >
              {m.role === "assistant" ? (
                <MarkdownAnswer
                  content={m.content}
                  citations={m.citations}
                  onCitationClick={onCitationClick}
                />
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.content === "" && (
          <p className="text-xs text-ink-faint">Thinking...</p>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-line p-3.5 flex gap-2 bg-paper-raised/80 backdrop-blur-sm sticky bottom-0">
        <input
          className="border border-line rounded-full px-4 py-2.5 flex-1 text-sm bg-paper text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-wash transition-colors"
          placeholder="Type a Query here....."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
        />
        <button
          className="bg-accent hover:bg-accent-hover text-accent-ink font-semibold px-5 py-2.5 rounded-full text-sm disabled:opacity-50 transition-colors"
          disabled={streaming}
          onClick={ask}
        >
          Ask
        </button>
      </div>
    </div>
  );
}

// Renders assistant markdown (bold, lists, tables via remark-gfm) while
// keeping [n] citation markers clickable. We pre-convert "[n]" into a
// markdown link "[n](citation:n)" before parsing, then intercept links
// with that scheme in the `a` renderer instead of letting them navigate.
function MarkdownAnswer({
  content,
  citations,
  onCitationClick,
}: {
  content: string;
  citations: Citation[] | undefined;
  onCitationClick: (c: Citation) => void;
}) {
  const withCitationLinks = citations?.length
    ? content.replace(/\[(\d+)\]/g, (match, n) =>
        citations.some((c) => c.n === Number(n)) ? `[${match}](citation:${n})` : match
      )
    : content;

  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("citation:")) {
              const n = Number(href.replace("citation:", ""));
              const citation = citations?.find((c) => c.n === n);
              if (!citation) return <>{children}</>;
              return (
                <button
                  className="text-accent underline decoration-accent/40 hover:decoration-accent font-semibold"
                  onClick={() => onCitationClick(citation)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                {children}
              </a>
            );
          },
        }}
      >
        {withCitationLinks}
      </ReactMarkdown>
    </div>
  );
}