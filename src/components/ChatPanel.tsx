"use client";

import { useState } from "react";

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
              className={`inline-block rounded-lg px-4 py-2.5 max-w-[80%] text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-accent text-accent-ink"
                  : "bg-paper-raised text-ink border border-line"
              }`}
            >
              {renderWithCitations(m.content, m.citations, onCitationClick)}
            </div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.content === "" && (
          <p className="text-xs text-ink-faint">Thinking...</p>
        )}
      </div>

      <div className="border-t border-line p-3.5 flex gap-2 bg-paper-raised">
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

// Splits assistant text on [n] markers and renders each as a clickable
// citation button wired to the source viewer.
function renderWithCitations(
  text: string,
  citations: Citation[] | undefined,
  onClick: (c: Citation) => void
) {
  if (!citations || citations.length === 0) return text;
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (!match) return <span key={i}>{part}</span>;
    const citation = citations.find((c) => c.n === Number(match[1]));
    if (!citation) return <span key={i}>{part}</span>;
    return (
      <button
        key={i}
        className="text-accent underline decoration-accent/40 hover:decoration-accent font-semibold"
        onClick={() => onClick(citation)}
      >
        {part}
      </button>
    );
  });
}
