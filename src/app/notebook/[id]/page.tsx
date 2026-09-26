"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { BookOpen, Library, MessageSquare, Plus, Route } from "lucide-react";
import { toast } from "sonner";
import AddSourceModal from "@/components/AddSourceModal";
import SourceList, { SourceItem } from "@/components/SourceList";
import ChatPanel from "@/components/ChatPanel";
import SourceViewer from "@/components/SourceViewer";
import RoadmapPanel from "@/components/RoadmapPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ThemeToggle from "@/components/ThemeToggle";

// One value drives both layouts. On a wide screen the three columns are always
// visible and this only picks the middle tab; on a phone it picks which single
// pane is on screen. The middle tab is held separately, so opening a source
// from a roadmap step does not also throw the middle column back to the chat.
type Pane = "sources" | "centre" | "source";
type CentreTab = "chat" | "roadmap";

export default function NotebookPage() {
  const { id } = useParams<{ id: string }>();
  const [notebookName, setNotebookName] = useState<string | null>(null);
  // Unknown until the notebook loads. Treated as read-only meanwhile, so the
  // demo never flashes controls that would only answer with a 403.
  const [isDemo, setIsDemo] = useState<boolean | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pane, setPane] = useState<Pane>("centre");
  const [centreTab, setCentreTab] = useState<CentreTab>("chat");
  const [viewerSourceId, setViewerSourceId] = useState<string | null>(null);
  const [viewerChunkId, setViewerChunkId] = useState<string | null>(null);
  const [viewerMetadata, setViewerMetadata] = useState<Record<string, any> | undefined>();

  const loadSources = useCallback(async () => {
    const res = await fetch(`/api/notebooks/${id}/sources`);
    setSources(await res.json());
    setSourcesLoading(false);
  }, [id]);

  useEffect(() => {
    fetch(`/api/notebooks/${id}`)
      .then((r) => r.json())
      .then((nb) => {
        setNotebookName(nb.name ?? "Untitled");
        setIsDemo(nb.is_demo === true);
      });
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
    // Read the current value: the reader may have opened another source
    // while the delete was running.
    setViewerSourceId((cur) => (cur === sourceId ? null : cur));
    loadSources();
  }

  async function reindexSource(sourceId: string) {
    const res = await fetch(`/api/sources/${sourceId}`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "That source could not be re-indexed.");
    }
    loadSources();
  }

  function openInViewer(sourceId: string, metadata?: Record<string, any>, chunkId?: string | null) {
    setViewerSourceId(sourceId);
    setViewerMetadata(metadata);
    setViewerChunkId(chunkId ?? null);
    setPane("source");
  }

  const readOnly = isDemo !== false;

  function showCentre(tab: CentreTab) {
    setCentreTab(tab);
    setPane("centre");
  }

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-paper-raised px-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 text-ink transition-colors hover:text-brand"
        >
          <BookOpen className="size-[1.125rem] text-brand" strokeWidth={2} aria-hidden />
          <span className="font-display text-sm font-bold tracking-tight">Commonplace</span>
        </Link>

        <span className="h-5 w-px shrink-0 bg-line" aria-hidden />

        {notebookName === null ? (
          <Skeleton className="h-5 w-40" />
        ) : readOnly ? (
          <h1 className="truncate font-display text-sm font-semibold text-ink">{notebookName}</h1>
        ) : renaming ? (
          <input
            autoFocus
            aria-label="Notebook name"
            className="min-w-0 rounded-md border border-brand bg-paper px-2 py-1 font-display text-sm font-semibold text-ink outline-none"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
            onBlur={submitRename}
          />
        ) : (
          <button
            title="Rename this notebook"
            className="truncate rounded-md px-1 font-display text-sm font-semibold text-ink transition-colors hover:text-brand"
            onClick={() => {
              setRenameValue(notebookName);
              setRenaming(true);
            }}
          >
            {notebookName}
          </button>
        )}

        {isDemo && (
          <Badge variant="outline" className="shrink-0 text-ink-muted">
            Demo, read-only
          </Badge>
        )}

        <span className="ml-auto shrink-0">
          <ThemeToggle />
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sources */}
        <aside
          className={`${pane === "sources" ? "flex" : "hidden"} w-full shrink-0 flex-col border-r border-line bg-paper-raised lg:flex lg:w-[17.5rem]`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
            <h2 className="font-display text-sm font-semibold text-ink">
              Sources
              {!sourcesLoading && sources.length > 0 && (
                <span className="ml-1.5 tabular-nums font-normal text-ink-faint">
                  {sources.length}
                </span>
              )}
            </h2>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {isDemo === null ? null : isDemo ? (
              <p className="mx-2 mb-3 rounded-md border border-line bg-paper px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
                This notebook is read-only. Ask it anything, then click a citation to
                see where the answer came from. To add your own sources, create a
                notebook from the home page.
              </p>
            ) : (
              <div className="px-2 pb-3">
                <Button
                  variant="outline"
                  className="w-full justify-center"
                  onClick={() => setShowAdd(true)}
                >
                  <Plus />
                  Add source
                </Button>
              </div>
            )}

            {sourcesLoading ? (
              <div className="space-y-2 px-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                ))}
              </div>
            ) : (
              <SourceList
                sources={sources}
                selectedId={viewerSourceId}
                onSelect={(sid) => openInViewer(sid)}
                onDelete={deleteSource}
                onReindex={reindexSource}
                readOnly={readOnly}
              />
            )}
          </div>
        </aside>

        {/* Chat and roadmap share the widest column: both are things you read. */}
        <Tabs
          value={centreTab}
          onValueChange={(value) => setCentreTab(value as CentreTab)}
          className={`${pane === "centre" ? "flex" : "hidden"} min-w-0 flex-1 flex-col gap-0 border-r border-line lg:flex`}
        >
          <TabsList
            variant="line"
            className="h-11 w-full shrink-0 justify-start gap-4 rounded-none border-b border-line bg-paper-raised px-4"
          >
            <TabsTrigger value="chat" className="flex-none data-active:text-brand after:bg-brand!">
              <MessageSquare />
              Chat
            </TabsTrigger>
            <TabsTrigger value="roadmap" className="flex-none data-active:text-brand after:bg-brand!">
              <Route />
              Roadmap
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat" keepMounted className="min-h-0 flex-1">
            <ChatPanel
              notebookId={id}
              sources={sources}
              onCitationClick={(c) => openInViewer(c.source_id, c.metadata, c.chunk_id)}
              onAnswerComplete={(c) => {
                // Only fills an empty panel, and never moves a phone off the
                // answer the reader is in the middle of.
                if (viewerSourceId === null) {
                  setViewerSourceId(c.source_id);
                  setViewerMetadata(c.metadata);
                  setViewerChunkId(c.chunk_id);
                }
              }}
            />
          </TabsContent>

          <TabsContent value="roadmap" keepMounted className="min-h-0 flex-1">
            <RoadmapPanel
              notebookId={id}
              sources={sources}
              onOpenStep={(sourceId, metadata) => openInViewer(sourceId, metadata)}
            />
          </TabsContent>
        </Tabs>

        {/* Source viewer */}
        <aside
          className={`${pane === "source" ? "flex" : "hidden"} w-full shrink-0 flex-col lg:flex lg:w-[26rem] xl:w-[28rem]`}
        >
          <SourceViewer
            sourceId={viewerSourceId}
            metadata={viewerMetadata}
            chunkId={viewerChunkId}
          />
        </aside>
      </div>

      {/* Phone navigation. The three columns cannot sit side by side at this
          width, so they become four destinations instead of being squeezed. */}
      <nav
        aria-label="Notebook sections"
        className="flex shrink-0 border-t border-line bg-paper-raised lg:hidden"
      >
        {(
          [
            ["sources", "Sources", Library, () => setPane("sources")],
            ["chat", "Chat", MessageSquare, () => showCentre("chat")],
            ["roadmap", "Roadmap", Route, () => showCentre("roadmap")],
            ["source", "Source", BookOpen, () => setPane("source")],
          ] as const
        ).map(([value, label, Icon, go]) => {
          const active =
            pane === "centre" ? centreTab === value : pane === value;
          return (
          <button
            key={value}
            onClick={go}
            aria-current={active}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-medium transition-colors ${
              active ? "text-brand" : "text-ink-faint hover:text-ink"
            }`}
          >
            <Icon className="size-[1.125rem]" strokeWidth={1.75} aria-hidden />
            {label}
          </button>
          );
        })}
      </nav>

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
