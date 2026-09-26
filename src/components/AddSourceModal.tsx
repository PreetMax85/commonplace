"use client";

import { useState } from "react";
import { ArrowLeft, Loader2, Upload } from "lucide-react";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "@/lib/limits";
import SourceIcon, { sourceLabel } from "./SourceIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type SourceKind = "pdf" | "text" | "url" | "youtube" | "vtt";

// The hint says what the app will do with it, which is the thing people are
// actually choosing between.
const TYPES: { key: SourceKind; hint: string }[] = [
  { key: "pdf", hint: "Cited by page" },
  { key: "youtube", hint: "Cited by timestamp" },
  { key: "url", hint: "Article text only" },
  { key: "text", hint: "Paste anything" },
  { key: "vtt", hint: "VTT or SRT file" },
];

export default function AddSourceModal({
  notebookId,
  onClose,
  onAdded,
}: {
  notebookId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [title, setTitle] = useState("");
  const [textValue, setTextValue] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    // Enter in the link field reaches here without going through the
    // disabled button, so a second press would add the source twice.
    if (!kind || submitting) return;
    if ((kind === "pdf" || kind === "vtt") && !file) {
      setError("Choose a file first.");
      return;
    }
    if ((kind === "url" || kind === "youtube") && !urlValue.trim()) {
      setError("Enter a link first.");
      return;
    }
    if (kind === "text" && !textValue.trim()) {
      setError("Paste some text first.");
      return;
    }
    if ((kind === "pdf" || kind === "vtt") && file!.size > MAX_UPLOAD_BYTES) {
      setError(`Files can be up to ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    if (kind === "text" && new Blob([textValue]).size > MAX_UPLOAD_BYTES) {
      setError(`Pasted text can be up to ${MAX_UPLOAD_MB} MB.`);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      if (kind === "pdf" || kind === "vtt") {
        const form = new FormData();
        form.append("type", kind);
        form.append("title", title || file!.name);
        form.append("file", file!);
        res = await fetch(`/api/notebooks/${notebookId}/sources`, { method: "POST", body: form });
      } else {
        res = await fetch(`/api/notebooks/${notebookId}/sources`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: kind,
            title: title || (kind === "text" ? "Pasted text" : urlValue),
            text: kind === "text" ? textValue : undefined,
            url: kind === "url" || kind === "youtube" ? urlValue : undefined,
          }),
        });
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "That source could not be added.");
        return;
      }

      onAdded();
      onClose();
    } catch {
      setError("No response from the server. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Closing cannot cancel a request already sent, and a failure reported
    // after closing would go nowhere, so the dialog stays until it answers.
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">
            {kind ? `Add ${sourceLabel(kind).toLowerCase()}` : "Add a source"}
          </DialogTitle>
          <DialogDescription>
            {kind
              ? "It will be indexed in the background, and searchable as soon as that finishes."
              : "Anything you add here becomes searchable, and answers can cite it."}
          </DialogDescription>
        </DialogHeader>

        {!kind ? (
          <div className="grid grid-cols-2 gap-2">
            {TYPES.map((t) => (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className="flex flex-col gap-1.5 rounded-lg border border-line bg-paper p-3 text-left transition-colors hover:border-brand-line hover:bg-brand-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand last:odd:col-span-2"
              >
                <span className="text-brand">
                  <SourceIcon type={t.key} className="size-[1.125rem]" />
                </span>
                <span className="text-sm font-medium text-ink">{sourceLabel(t.key)}</span>
                <span className="text-xs text-ink-faint">{t.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 text-ink-muted"
              disabled={submitting}
              onClick={() => {
                setKind(null);
                setError(null);
              }}
            >
              <ArrowLeft />
              All types
            </Button>

            <Input
              placeholder="Title (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            {(kind === "pdf" || kind === "vtt") && (
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-dashed border-line-strong px-3 py-4 text-sm transition-colors hover:border-brand-line hover:bg-brand-wash">
                <Upload className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {file ? file.name : `Choose a ${kind === "pdf" ? "PDF" : "VTT or SRT"} file`}
                </span>
                <input
                  type="file"
                  className="sr-only"
                  accept={kind === "pdf" ? ".pdf" : ".vtt,.srt"}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            )}

            {kind === "text" && (
              <Textarea
                className="h-32"
                placeholder="Paste the text here"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
              />
            )}

            {(kind === "url" || kind === "youtube") && (
              <Input
                placeholder={
                  kind === "youtube" ? "https://youtube.com/watch?v=..." : "https://..."
                }
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            )}

            {error && <p className="text-sm text-status-error">{error}</p>}

            <Button className="w-full" size="lg" disabled={submitting} onClick={submit}>
              {submitting && <Loader2 className="animate-spin" />}
              {submitting ? "Adding" : "Add source"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
