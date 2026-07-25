"use client";

import { useState } from "react";

type SourceKind = "pdf" | "text" | "url" | "youtube" | "vtt";

const TYPES: { key: SourceKind; label: string }[] = [
  { key: "pdf", label: "PDF" },
  { key: "youtube", label: "YT Link" },
  { key: "text", label: "Text" },
  { key: "vtt", label: "VTT" },
  { key: "url", label: "Web Link" },
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
    if (!kind) return;
    if ((kind === "pdf" || kind === "vtt") && !file) {
      setError("Choose a file first.");
      return;
    }
    if ((kind === "url" || kind === "youtube") && !urlValue.trim()) {
      setError("Enter a URL first.");
      return;
    }
    if (kind === "text" && !textValue.trim()) {
      setError("Paste some text first.");
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
        const body = await res.json().catch(() => ({ error: "Upload failed" }));
        setError(body.error ?? "Upload failed");
        return;
      }

      onAdded();
      onClose();
    } catch {
      setError("Network error — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink/30 backdrop-blur-[2px] flex items-center justify-center z-50 p-4">
      <div className="bg-paper-raised rounded-lg p-6 w-full max-w-md shadow-2xl shadow-ink/10 border border-line">
        <div className="flex justify-between items-center mb-5">
          <h2 className="font-display font-semibold text-lg text-ink">Add Source</h2>
          <button onClick={onClose} className="text-ink-faint hover:text-ink transition-colors">
            ✕
          </button>
        </div>

        {!kind ? (
          <div className="grid grid-cols-2 gap-3">
            {TYPES.map((t) => (
              <button
                key={t.key}
                onClick={() => setKind(t.key)}
                className="border border-line rounded-md py-6 font-medium text-ink hover:border-accent hover:bg-accent-wash transition-colors"
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            <button
              className="text-sm text-ink-faint hover:text-ink transition-colors"
              onClick={() => {
                setKind(null);
                setError(null);
              }}
            >
              ← back
            </button>

            {error && <p className="text-sm text-status-error">{error}</p>}

            <input
              className="border border-line rounded-md px-3 py-2 w-full bg-paper text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-wash transition-colors"
              placeholder="Title (optional)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            {(kind === "pdf" || kind === "vtt") && (
              <input
                type="file"
                accept={kind === "pdf" ? ".pdf" : ".vtt,.srt"}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm text-ink-muted file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:bg-accent-wash file:text-ink file:font-medium"
              />
            )}

            {kind === "text" && (
              <textarea
                className="border border-line rounded-md px-3 py-2 w-full h-32 bg-paper text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-wash transition-colors"
                placeholder="Paste text..."
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
              />
            )}

            {(kind === "url" || kind === "youtube") && (
              <input
                className="border border-line rounded-md px-3 py-2 w-full bg-paper text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-wash transition-colors"
                placeholder={kind === "youtube" ? "https://youtube.com/watch?v=..." : "https://..."}
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
              />
            )}

            <button
              disabled={submitting}
              onClick={submit}
              className="bg-accent hover:bg-accent-hover text-accent-ink font-semibold px-4 py-2.5 rounded-md w-full disabled:opacity-50 transition-colors"
            >
              {submitting ? "Uploading..." : "Add Source"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
