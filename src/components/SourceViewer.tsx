"use client";

import { useEffect, useState } from "react";

interface ViewData {
  source: { id: string; type: string; title: string; raw_ref: string };
  chunks: { id: string; content: string; metadata: any }[];
  fileUrl: string | null;
}

export default function SourceViewer({
  sourceId,
  metadata,
}: {
  sourceId: string | null;
  metadata?: Record<string, any>;
}) {
  const [data, setData] = useState<ViewData | null>(null);

  useEffect(() => {
    if (!sourceId) return;
    fetch(`/api/sources/${sourceId}/view`)
      .then((r) => r.json())
      .then(setData);
  }, [sourceId]);

  if (!sourceId) {
    return (
      <div className="h-full flex items-center justify-center text-ink-faint text-sm p-8 text-center bg-paper-sunken">
        Ask a question, then click a citation to view its source here.
      </div>
    );
  }

  if (!data) return <div className="p-5 text-ink-faint text-sm">Loading source...</div>;

  if ((data as any).error || !data.source) {
    return (
      <div className="h-full flex items-center justify-center text-ink-faint text-sm p-8 text-center bg-paper-sunken">
        ⚠️ Source not found or deleted.
      </div>
    );
  }

  const { source, chunks, fileUrl } = data;

  return (
    <div className="h-full overflow-y-auto p-5 bg-paper-sunken">
      <h3 className="font-display font-semibold text-ink mb-4 truncate">{source.title}</h3>

      {source.type === "pdf" && fileUrl && (
        <iframe
          src={`${fileUrl}#page=${metadata?.page ?? 1}`}
          className="w-full h-[70vh] border border-line rounded-lg"
        />
      )}

      {source.type === "youtube" && (
        <iframe
          className="w-full aspect-video rounded-lg"
          src={`https://www.youtube.com/embed/${source.raw_ref}?start=${metadata?.timestamp_start ?? 0}`}
          allow="autoplay; encrypted-media"
          allowFullScreen
        />
      )}

      {(source.type === "text" || source.type === "vtt" || source.type === "url") && (
        <div className="space-y-3 text-sm leading-relaxed text-ink-muted">
          {chunks.map((c) => {
            const isCited =
              metadata &&
              ((metadata.chunk_index !== undefined && c.metadata.chunk_index === metadata.chunk_index) ||
                (metadata.timestamp_start !== undefined &&
                  c.metadata.timestamp_start === metadata.timestamp_start));
            return (
              <p
                key={c.id}
                className={
                  isCited
                    ? "bg-accent-wash text-ink rounded-md px-2.5 py-1.5 -mx-2.5"
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
  );
}
