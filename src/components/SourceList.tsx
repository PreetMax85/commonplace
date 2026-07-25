"use client";

import { useState } from "react";
import StatusDot from "./StatusDot";

export interface SourceItem {
  id: string;
  title: string;
  type: string;
  status: string;
  error_message?: string | null;
}

export default function SourceList({
  sources,
  selectedId,
  onSelect,
  onDelete,
  onReindex,
}: {
  sources: SourceItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void> | void;
  onReindex: (id: string) => Promise<void> | void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (sources.length === 0) {
    return (
      <div className="text-sm text-ink-faint px-3 py-8 text-center border border-dashed border-line rounded-lg">
        No sources yet.
        <br />
        Add a PDF, link, or transcript to get started.
      </div>
    );
  }

  async function handleDelete(id: string) {
    setPendingId(id);
    try {
      await onDelete(id);
    } finally {
      setPendingId(null);
    }
  }

  async function handleReindex(id: string) {
    setPendingId(id);
    try {
      await onReindex(id);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <ul className="space-y-1">
      {sources.map((s) => (
        <li key={s.id}>
          <div
            className={`group flex items-center justify-between px-2.5 py-2 rounded-md cursor-pointer text-sm transition-colors ${
              selectedId === s.id ? "bg-accent-wash" : "hover:bg-paper-sunken"
            }`}
            onClick={() => onSelect(s.id)}
          >
            <span className="flex items-center gap-2 truncate">
              <StatusDot status={s.status} />
              <span className="truncate text-ink">{s.title}</span>
            </span>
            <span className="flex gap-2 opacity-0 group-hover:opacity-100 shrink-0 transition-opacity">
              {pendingId === s.id ? (
                <span className="text-xs text-ink-faint animate-pulse">...</span>
              ) : (
                <>
                  {(s.type === "url" || s.type === "youtube") && (
                    <button
                      title="Re-index"
                      className="text-xs text-ink-faint hover:text-accent transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReindex(s.id);
                      }}
                    >
                      ↻
                    </button>
                  )}
                  <button
                    title="Remove"
                    className="text-xs text-ink-faint hover:text-status-error transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(s.id);
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </span>
          </div>
          {s.status === "error" && s.error_message && (
            <p className="text-xs text-status-error px-2.5 pb-1.5 truncate" title={s.error_message}>
              ⚠ {s.error_message}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
