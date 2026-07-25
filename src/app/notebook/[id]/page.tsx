"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import AddSourceModal from "@/components/AddSourceModal";
import SourceList, { SourceItem } from "@/components/SourceList";
import ChatPanel from "@/components/ChatPanel";
import SourceViewer from "@/components/SourceViewer";
import RoadmapPanel from "@/components/RoadmapPanel";

export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const [notebookName, setNotebookName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [viewerSourceId, setViewerSourceId] = useState<string | null>(null);
  const [viewerMetadata, setViewerMetadata] = useState<Record<string, any> | undefined>();

  const loadSources = useCallback(async () => {
    const res = await fetch(`/api/notebooks/${id}/sources`);
    setSources(await res.json());
    setSourcesLoading(false);
  }, [id]);

  useEffect(() => {
    fetch(`/api/notebooks/${id}`)
      .then((r) => r.json())
      .then((nb) => setNotebookName(nb.name ?? "Untitled"));
  }, [id]);

  useEffect(() => {
    loadSources();
    // Poll for status changes (uploading -> indexing -> ready) every 3s
    // while anything is still in flight.
    const interval = setInterval(() => {
      setSources((current) => {
        if (current.some((s) => s.status === "uploading" || s.status === "indexing")) {
          loadSources();
        }
        return current;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [loadSources]);

  async function submitRename() {
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === notebookName) return;
    await fetch(`/api/notebooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setNotebookName(name);
  }

  async function deleteSource(sourceId: string) {
    await fetch(`/api/sources/${sourceId}`, { method: "DELETE" });
    loadSources();
  }

  async function reindexSource(sourceId: string) {
    await fetch(`/api/sources/${sourceId}`, { method: "POST" });
    loadSources();
  }

  return (
    <div className="h-screen flex flex-col bg-paper">
      {/* Header */}
      <header className="border-b border-line px-5 py-3 flex items-center gap-4 shrink-0 bg-paper-raised">
        <Link href="/" className="text-ink-faint hover:text-accent text-sm transition-colors">
          ← Notebooks
        </Link>
        {renaming ? (
          <input
            autoFocus
            className="border border-accent rounded-md px-2 py-1 text-sm font-display font-semibold bg-paper outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
            onBlur={submitRename}
          />
        ) : (
          <button
            className="font-display font-semibold text-sm text-ink hover:text-accent transition-colors"
            onClick={() => {
              setRenameValue(notebookName ?? "");
              setRenaming(true);
            }}
          >
            {notebookName ?? "Loading..."}
          </button>
        )}
      </header>

      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <aside className="w-64 border-r border-line flex flex-col bg-paper-raised">
          <div className="flex-1 overflow-y-auto p-3">
            <button
              className="border border-line rounded-full py-2.5 mb-4 w-full text-sm font-semibold text-ink hover:border-accent hover:bg-accent-wash transition-colors"
              onClick={() => setShowAdd(true)}
            >
              + Add Source
            </button>
            {sourcesLoading ? (
              <p className="text-sm text-ink-faint px-2">Loading sources...</p>
            ) : (
              <SourceList
                sources={sources}
                selectedId={viewerSourceId}
                onSelect={(sid) => {
                  setViewerSourceId(sid);
                  setViewerMetadata(undefined);
                }}
                onDelete={deleteSource}
                onReindex={reindexSource}
              />
            )}
          </div>
          <RoadmapPanel
            notebookId={id}
            onOpenStep={(sourceId, metadata) => {
              setViewerSourceId(sourceId);
              setViewerMetadata(metadata);
            }}
          />
        </aside>

        {/* Chat */}
        <section className="flex-1 border-r border-line min-h-0">
          <ChatPanel
            notebookId={id}
            onCitationClick={(c) => {
              setViewerSourceId(c.source_id);
              setViewerMetadata(c.metadata);
            }}
          />
        </section>

        {/* Source viewer */}
        <aside className="w-[420px] min-h-0">
          <SourceViewer sourceId={viewerSourceId} metadata={viewerMetadata} />
        </aside>
      </div>

      {showAdd && (
        <AddSourceModal
          notebookId={id}
          onClose={() => setShowAdd(false)}
          onAdded={loadSources}
        />
      )}
    </div>
  );
}
