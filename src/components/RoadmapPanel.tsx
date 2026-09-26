"use client";

import { useState } from "react";
import { Loader2, Play, Route, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTimestamp } from "@/lib/format";
import SourceIcon from "./SourceIcon";
import type { SourceItem } from "./SourceList";

interface RoadmapStep {
  concept: string;
  why: string;
  source_id: string;
  timestamp_start: number;
  timestamp_end: number;
}

export default function RoadmapPanel({
  notebookId,
  sources,
  onOpenStep,
}: {
  notebookId: string;
  sources: SourceItem[];
  onOpenStep: (sourceId: string, metadata: { timestamp_start: number; timestamp_end: number }) => void;
}) {
  const [steps, setSteps] = useState<RoadmapStep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The roadmap is built from timed transcripts, so a notebook of PDFs alone
  // has nothing to order. Saying that up front beats a failed request.
  const timed = sources.filter(
    (s) => (s.type === "youtube" || s.type === "vtt") && s.status === "ready"
  );
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  async function generate() {
    setLoading(true);
    setError(null);
    setSteps(null);
    try {
      const res = await fetch("/api/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebookId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "The roadmap could not be built. Try again in a moment.");
        return;
      }
      setSteps(data.steps);
    } catch {
      setError("The roadmap could not be built. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-6 py-7">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <h2 className="flex items-center gap-2 font-display text-xl font-bold tracking-tight text-ink">
              <Route className="size-5 text-brand" strokeWidth={1.75} aria-hidden />
              Learning roadmap
            </h2>
            <p className="mt-2 leading-relaxed text-ink-muted">
              {timed.length === 0
                ? "The roadmap orders the ideas in a video or transcript into the sequence you should watch them in. This notebook has no timed source yet, so add a video or a VTT file to build one."
                : "The ideas in this notebook's videos, put in the order they make most sense to learn, each one linked to the moment it is explained."}
            </p>
          </div>
          {timed.length > 0 && (
            <Button onClick={generate} disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              {loading ? "Building" : steps ? "Build again" : "Build roadmap"}
            </Button>
          )}
        </header>

        {timed.length > 0 && !steps && !loading && (
          <div className="mt-6">
            <p className="text-sm text-ink-faint">Built from</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {timed.map((s) => (
                <li
                  key={s.id}
                  className="flex max-w-full items-center gap-1.5 rounded-pill border border-line bg-paper-raised py-1 pl-2 pr-2.5 text-xs text-ink-muted"
                >
                  <SourceIcon type={s.type} className="size-3 shrink-0" />
                  <span className="truncate">{s.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="mt-6 flex items-start gap-2 rounded-lg border border-status-error/30 bg-status-error/5 px-4 py-3 text-sm leading-relaxed text-status-error">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        {loading && (
          <ul className="mt-8 space-y-6">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex gap-4">
                <Skeleton className="size-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/5" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {steps && steps.length > 0 && (
          <ol className="mt-8">
            {steps.map((step, i) => {
              const source = sourceById.get(step.source_id);
              const last = i === steps.length - 1;
              return (
                <li key={i} className="flex gap-4">
                  {/* Number and the rule joining it to the next step: the
                      sequence is the content here, so it is drawn, not implied. */}
                  <div className="flex shrink-0 flex-col items-center">
                    <span className="flex size-7 items-center justify-center rounded-full border border-brand-line bg-brand-wash font-display text-xs font-bold text-brand">
                      {i + 1}
                    </span>
                    {!last && <span className="my-1 w-px flex-1 bg-line" aria-hidden />}
                  </div>
                  <div className={last ? "min-w-0 flex-1" : "min-w-0 flex-1 pb-7"}>
                    <h3 className="font-display font-semibold leading-snug text-ink">
                      {step.concept}
                    </h3>
                    <p className="mt-1 leading-relaxed text-sm text-ink-muted">{step.why}</p>
                    <button
                      onClick={() =>
                        onOpenStep(step.source_id, {
                          timestamp_start: step.timestamp_start,
                          timestamp_end: step.timestamp_end,
                        })
                      }
                      className="mt-2.5 flex max-w-full items-center gap-1.5 rounded-pill border border-line bg-paper-raised py-1 pl-2 pr-2.5 text-xs text-ink-muted transition-colors hover:border-brand-line hover:bg-brand-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    >
                      <Play className="size-3 shrink-0 fill-current" aria-hidden />
                      <span className="truncate">{source?.title ?? "Source"}</span>
                      <span className="shrink-0 text-ink-faint">
                        {formatTimestamp(step.timestamp_start)}
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {steps && steps.length === 0 && (
          <p className="mt-6 text-sm text-ink-muted">
            No steps came back. The transcript may be too short to order.
          </p>
        )}
      </div>
    </div>
  );
}
