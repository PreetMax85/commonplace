"use client";

import { useState } from "react";
import { Loader2, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import SourceIcon, { sourceLabel } from "./SourceIcon";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

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
  readOnly = false,
}: {
  sources: SourceItem[];
  readOnly?: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void> | void;
  onReindex: (id: string) => Promise<void> | void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<SourceItem | null>(null);

  if (sources.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center">
        <p className="text-sm font-medium text-ink">Nothing to read yet</p>
        <p className="mt-1 text-sm text-ink-muted">
          Add a PDF, a web page, a video or a transcript and it will be searchable
          once indexing finishes.
        </p>
      </div>
    );
  }

  async function run(id: string, action: (id: string) => Promise<void> | void) {
    setPendingId(id);
    try {
      await action(id);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <>
      <ul className="space-y-0.5">
        {sources.map((s) => {
          const selected = selectedId === s.id;
          const busy = pendingId === s.id;
          return (
            <li key={s.id}>
              <div
                role="button"
                tabIndex={0}
                aria-current={selected}
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => {
                  // Keys pressed on the Remove and Re-index buttons bubble up
                  // here too, and preventDefault would cancel their own action.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(s.id);
                  }
                }}
                className={`group relative flex cursor-pointer items-start gap-2.5 rounded-md py-2 pl-3 pr-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand ${
                  selected ? "bg-brand-wash" : "hover:bg-paper-sunken"
                }`}
              >
                {/* A rule in the margin marks the source being read, the way a
                    slip of paper marks a page. */}
                <span
                  className={`absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full transition-colors ${
                    selected ? "bg-brand" : "bg-transparent"
                  }`}
                />
                <span className={selected ? "mt-0.5 text-brand" : "mt-0.5 text-ink-faint"}>
                  <SourceIcon type={s.type} />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm leading-snug text-ink" title={s.title}>
                    {s.title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                    {sourceLabel(s.type)}
                    {s.status === "indexing" || s.status === "uploading" ? (
                      <>
                        <span aria-hidden>·</span>
                        <Loader2 className="size-3 animate-spin" aria-hidden />
                        {s.status === "uploading" ? "Uploading" : "Indexing"}
                      </>
                    ) : s.status === "error" ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="text-status-error">Failed</span>
                      </>
                    ) : null}
                  </span>
                </span>

                {!readOnly && (
                  <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    {busy ? (
                      <Loader2 className="mt-1 size-3.5 animate-spin text-ink-faint" aria-hidden />
                    ) : (
                      <>
                        {(s.type === "url" || s.type === "youtube") && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Re-index ${s.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              run(s.id, onReindex);
                            }}
                          >
                            <RotateCw />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${s.title}`}
                          className="hover:text-status-error"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirming(s);
                          }}
                        >
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </span>
                )}
              </div>

              {s.error_message && (
                <p className="flex items-start gap-1.5 px-3 pb-2 pt-0.5 text-xs text-status-error">
                  <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
                  <span className="line-clamp-3">{s.error_message}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this source?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.title} and everything indexed from it will be deleted.
              Answers will no longer be able to cite it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target) run(target.id, onDelete);
              }}
            >
              Remove source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
