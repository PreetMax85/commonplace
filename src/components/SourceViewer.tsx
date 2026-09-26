"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import SourceIcon, { sourceLabel } from "./SourceIcon";
import { Skeleton } from "@/components/ui/skeleton";

interface ViewData {
  source: { id: string; type: string; title: string; raw_ref: string };
  chunks: { id: string; content: string; metadata: any }[];
  fileUrl: string | null;
}

export default function SourceViewer({
  sourceId,
  metadata,
  chunkId,
}: {
  sourceId: string | null;
  metadata?: Record<string, any>;
  // Citations identify the exact chunk. Roadmap steps have no chunk to point
  // at, so they still arrive as metadata alone and match on timestamp below.
  chunkId?: string | null;
}) {
  const [data, setData] = useState<ViewData | null>(null);
  const highlightRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!sourceId) return;
    setData(null);
    fetch(`/api/sources/${sourceId}/view`)
      .then((r) => r.json())
      .then(setData);
  }, [sourceId]);

  // Once the cited chunk is on screen, scroll it into the center of the
  // pane instead of leaving the user to hunt for the highlight themselves.
  useEffect(() => {
    if (data && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [data, metadata, chunkId]);

  if (!sourceId) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-paper-sunken px-8 py-10 text-center">
        <BookOpen className="size-6 text-ink-faint" strokeWidth={1.75} aria-hidden />
        <p className="mt-3 text-sm font-medium text-ink">The source, side by side</p>
        <p className="mt-1 max-w-[16rem] text-sm leading-relaxed text-ink-muted">
          Pick a source, or click a citation in an answer, and it opens here at
          the exact page, moment or passage.
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full space-y-3 bg-paper-sunken p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  const { source, chunks, fileUrl } = data;

  return (
    <div className="flex h-full flex-col bg-paper-sunken">
      <header className="flex items-start gap-2.5 border-b border-line px-5 py-3.5">
        <span className="mt-0.5 text-ink-faint">
          <SourceIcon type={source.type} />
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-display text-sm font-semibold text-ink" title={source.title}>
            {source.title}
          </h2>
          <p className="text-xs text-ink-faint">{sourceLabel(source.type)}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
        {source.type === "pdf" && fileUrl && (
          <iframe
            title={source.title}
            src={`${fileUrl}#page=${metadata?.page ?? 1}`}
            // Fills whatever height the pane has, rather than guessing from
            // the viewport, which was wrong on a phone with the bottom bar.
            className="min-h-[22rem] w-full flex-1 rounded-lg border border-line bg-paper"
          />
        )}

        {source.type === "youtube" && (
          <iframe
            title={source.title}
            className="aspect-video w-full shrink-0 rounded-lg border border-line"
            src={`https://www.youtube.com/embed/${source.raw_ref}?start=${metadata?.timestamp_start ?? 0}`}
            allow="autoplay; encrypted-media"
            allowFullScreen
          />
        )}

        {(source.type === "text" || source.type === "vtt" || source.type === "url") && (
          <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
            {chunks.map((c) => {
              const isCited = chunkId
                ? c.id === chunkId
                : metadata !== undefined &&
                  metadata.timestamp_start !== undefined &&
                  c.metadata.timestamp_start === metadata.timestamp_start;
              return (
                <p
                  key={c.id}
                  ref={isCited ? highlightRef : undefined}
                  className={
                    isCited
                      ? "-mx-2.5 rounded-md border-l-[3px] border-brand bg-brand-wash px-2.5 py-1.5 text-ink"
                      : ""
                  }
                >
                  {c.content}
                </p>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
