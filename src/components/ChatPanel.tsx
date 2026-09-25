"use client";

import { useState, useRef, useEffect } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Quote, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import SourceIcon from "./SourceIcon";
import type { SourceItem } from "./SourceList";

interface Citation {
  n: number;
  source_id: string;
  chunk_id: string;
  metadata: Record<string, any>;
  snippet: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  // Refusals and failures are shown in the thread but never sent back as
  // history, where they would cost tokens and confuse the next answer.
  error?: boolean;
}

// "page 12", "4:07", or nothing when a chunk has no natural locator.
function locatorLabel(metadata: Record<string, any> | undefined): string | null {
  if (!metadata) return null;
  if (metadata.page !== undefined) return `page ${metadata.page}`;
  if (metadata.timestamp_start !== undefined) {
    const total = Math.floor(metadata.timestamp_start);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }
  if (metadata.section) return String(metadata.section);
  return null;
}

// Source titles carry their author in brackets, which is useful in the sidebar
// and too long everywhere else.
function shortTitle(title: string, max = 42): string {
  const withoutAuthor = title.replace(/\s*[([].*$/, "").trim() || title;
  return withoutAuthor.length > max ? `${withoutAuthor.slice(0, max).trimEnd()}...` : withoutAuthor;
}

// Built from the notebook's own sources rather than hard-coded, so a brand new
// notebook gets openers that are actually about what is in it. The first one
// only appears once there is more than one source to compare.
function starterQuestions(sources: SourceItem[]): string[] {
  const ready = sources.filter((s) => s.status === "ready");
  if (ready.length === 0) return [];
  const short = (title: string) => shortTitle(title);
  const questions = [`What is the main idea of ${short(ready[0].title)}?`];
  if (ready.length > 1) {
    questions.unshift("Where do these sources disagree with each other?");
    questions.push(`How does ${short(ready[0].title)} relate to ${short(ready[1].title)}?`);
  }
  questions.push("Summarise the key ideas across every source.");
  return questions.slice(0, 4);
}

export default function ChatPanel({
  notebookId,
  sources,
  onCitationClick,
  onAnswerComplete,
}: {
  notebookId: string;
  sources: SourceItem[];
  onCitationClick: (citation: Citation) => void;
  // The top citation of a finished answer, offered so the viewer can fill
  // itself the first time rather than sitting empty next to a cited answer.
  onAnswerComplete: (topCitation: Citation) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to the latest message, including mid-stream as tokens arrive.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  async function ask(text?: string) {
    const question = (text ?? input).trim();
    if (!question || streaming) return;
    setInput("");
    // Snapshot history BEFORE appending the new user turn — this is what
    // the backend uses to resolve follow-up references.
    const history = messages
      .filter((m, i) => !m.error && !messages[i + 1]?.error)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: question }]);
    setStreaming(true);

    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebookId, question, history }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: "Something went wrong. Try again." }));
      setMessages((m) => [...m, { role: "assistant", content: err.error, error: true }]);
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
        } else if (type === "error") {
          // Failures after the response headers are sent can only arrive as a
          // stream event. Without this the bubble just stops, and rate limiting
          // is the expected failure on a free tier, so silence is the wrong
          // thing to show. Anything already streamed is kept above the notice.
          answer += `${answer ? "\n\n" : ""}${data.error}`;
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { role: "assistant", content: answer, citations, error: true };
            return copy;
          });
        }
      }
    }

    setStreaming(false);
    if (citations.length > 0) onAnswerComplete(citations[0]);
    inputRef.current?.focus();
  }

  const starters = starterQuestions(sources);
  const titleById = new Map(sources.map((s) => [s.id, s]));

  return (
    <div className="flex h-full flex-col bg-paper">
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-2xl flex-col justify-center px-6 py-10">
            <Quote className="size-6 text-brand" strokeWidth={1.75} aria-hidden />
            <h2 className="mt-4 font-display text-2xl font-bold tracking-tight text-ink">
              Ask across everything in this notebook
            </h2>
            <p className="mt-2 max-w-prose leading-relaxed text-ink-muted">
              Answers are built only from this notebook&rsquo;s sources, and every
              claim carries a number you can click to land on the page, timestamp
              or passage it came from.
            </p>
            {starters.length > 0 && (
              <div className="mt-7 flex flex-wrap gap-2">
                {starters.map((q) => (
                  <button
                    key={q}
                    onClick={() => ask(q)}
                    className="rounded-pill border border-line bg-paper-raised px-3.5 py-2 text-left text-sm text-ink transition-colors hover:border-brand-line hover:bg-brand-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-2xl space-y-7 px-6 py-7">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <p className="max-w-[85%] rounded-lg rounded-br-sm bg-brand px-4 py-2.5 text-sm leading-relaxed text-brand-ink">
                    {m.content}
                  </p>
                </div>
              ) : m.error ? (
                <p
                  key={i}
                  className="flex items-start gap-2 rounded-lg border border-status-error/30 bg-status-error/5 px-4 py-3 text-sm leading-relaxed text-status-error"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>{m.content}</span>
                </p>
              ) : (
                <div key={i}>
                  <Answer
                    content={m.content}
                    citations={m.citations}
                    onCitationClick={onCitationClick}
                  />
                  <CitedSources
                    content={m.content}
                    citations={m.citations}
                    titleById={titleById}
                    onCitationClick={onCitationClick}
                  />
                </div>
              )
            )}
            {streaming && messages[messages.length - 1]?.content === "" && (
              <p className="flex items-center gap-2 text-sm text-ink-faint">
                <span className="size-1.5 animate-pulse rounded-full bg-brand" aria-hidden />
                Reading the sources
              </p>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-line bg-paper-raised/80 px-4 py-3 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl items-center gap-2">
          <input
            ref={inputRef}
            className="h-10 flex-1 rounded-pill border border-line bg-paper px-4 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand-line focus:ring-2 focus:ring-brand-wash"
            placeholder="Ask about these sources"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <Button
            size="icon-lg"
            className="rounded-pill"
            disabled={streaming || input.trim() === ""}
            aria-label="Send question"
            onClick={() => ask()}
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
    </div>
  );
}

// Which citation numbers the answer actually used. Showing all eight retrieved
// chunks would bury the two the answer leaned on.
function usedCitations(content: string, citations: Citation[] | undefined): Citation[] {
  if (!citations?.length) return [];
  const used = new Set<number>();
  for (const [, n] of content.matchAll(/[[【](\d+)(?:†[^\]】\s]{0,32})?[\]】]/g)) {
    used.add(Number(n));
  }
  return citations.filter((c) => used.has(c.n));
}

function CitedSources({
  content,
  citations,
  titleById,
  onCitationClick,
}: {
  content: string;
  citations: Citation[] | undefined;
  titleById: Map<string, SourceItem>;
  onCitationClick: (c: Citation) => void;
}) {
  const used = usedCitations(content, citations);
  if (used.length === 0) return null;

  return (
    <ul className="mt-3.5 flex flex-wrap gap-1.5">
      {used.map((c) => {
        const source = titleById.get(c.source_id);
        const locator = locatorLabel(c.metadata);
        return (
          <li key={c.n}>
            <button
              onClick={() => onCitationClick(c)}
              title={c.snippet}
              className="flex max-w-full items-center gap-1.5 rounded-pill border border-line bg-paper-raised py-1 pl-2 pr-2.5 text-xs text-ink-muted transition-colors hover:border-brand-line hover:bg-brand-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-brand-ink">
                {c.n}
              </span>
              <SourceIcon type={source?.type ?? ""} className="size-3 shrink-0" />
              <span className="truncate">
                {source ? shortTitle(source.title, 34) : "Source"}
              </span>
              {locator && <span className="shrink-0 text-ink-faint">{locator}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// Renders assistant markdown (bold, lists, tables via remark-gfm) while
// keeping [n] citation markers clickable. We pre-convert "[n]" into a
// markdown link "[n](citation:n)" before parsing, then intercept links
// with that scheme in the `a` renderer instead of letting them navigate.
// gpt-oss often ignores the prompt and cites in its own training format,
// "【n】" or "【n†L1-L4】", so those are accepted and rewritten as "[n]".
function Answer({
  content,
  citations,
  onCitationClick,
}: {
  content: string;
  citations: Citation[] | undefined;
  onCitationClick: (c: Citation) => void;
}) {
  const withCitationLinks = citations?.length
    ? content.replace(/[[【](\d+)(?:†[^\]】\s]{0,32})?[\]】]/g, (match, n) =>
        citations.some((c) => c.n === Number(n)) ? `[[${n}]](citation:${n})` : match
      )
    : content;

  return (
    <div className="prose-chat text-[0.9375rem] leading-7 text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // react-markdown blanks any href outside http, https, mailto and a few
        // others, which turned every citation into an empty link that opened
        // the app in a new tab. Let the citation scheme through untouched.
        urlTransform={(url) => (url.startsWith("citation:") ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("citation:")) {
              const n = Number(href.replace("citation:", ""));
              const citation = citations?.find((c) => c.n === n);
              if (!citation) return <>{children}</>;
              return (
                <button
                  className="mx-px align-super text-[0.7em] font-semibold text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
                  onClick={() => onCitationClick(citation)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline">
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
