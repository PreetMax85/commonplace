"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, BookOpen, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import ThemeToggle from "@/components/ThemeToggle";
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

interface Notebook {
  id: string;
  name: string;
  is_demo: boolean;
  created_at: string;
  // PostgREST returns an embedded count as a one-row array.
  sources: { count: number }[];
}

function sourceCount(nb: Notebook): number {
  return nb.sources?.[0]?.count ?? 0;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState<Notebook | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/notebooks");
      const body = await res.json();
      // A failed request returns { error }, which would crash the page if it
      // were treated as the list.
      if (!res.ok || !Array.isArray(body)) throw new Error();
      setNotebooks(body);
      setLoadError(false);
    } catch {
      // After a create, rename or delete the list on screen is still worth
      // keeping, so only the first load replaces it with the error.
      if (loading) setLoadError(true);
      else toast.error("The notebook list could not be refreshed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createNotebook() {
    if (!newName.trim() || creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/notebooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setCreateError(body.error ?? "That notebook could not be created.");
        return;
      }
      setNewName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function deleteNotebook(id: string) {
    await fetch(`/api/notebooks/${id}`, { method: "DELETE" });
    load();
  }

  async function submitRename(id: string) {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name) return;
    await fetch(`/api/notebooks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    load();
  }

  const demo = notebooks.find((nb) => nb.is_demo);
  const mine = notebooks.filter((nb) => !nb.is_demo);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-14 sm:py-20">
      <div className="flex items-center gap-2 text-ink">
        <BookOpen className="size-5 text-brand" strokeWidth={2} aria-hidden />
        <span className="font-display text-base font-bold tracking-tight">Commonplace</span>
        <span className="ml-auto">
          <ThemeToggle />
        </span>
      </div>
      <h1 className="mt-5 max-w-[19ch] font-display text-3xl font-bold leading-[1.15] tracking-tight text-ink sm:text-4xl">
        Keep what you read, and ask it questions
      </h1>
      <p className="mt-3 max-w-prose leading-relaxed text-ink-muted">
        Put PDFs, web pages, videos and transcripts into a notebook. Ask across all
        of them at once and get an answer that cites the page, the timestamp or the
        passage it came from.
      </p>

      {demo && (
        <Link
          href={`/notebook/${demo.id}`}
          className="group mt-9 flex items-center gap-4 rounded-lg border border-brand-line bg-brand-wash px-4 py-3.5 transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">
              Start with the demo notebook
            </span>
            <span className="mt-0.5 block truncate text-sm text-ink-muted">
              {demo.name} &middot; {sourceCount(demo)} sources, nothing to upload
            </span>
          </span>
          <ArrowRight
            className="size-4 shrink-0 text-brand transition-transform group-hover:translate-x-0.5"
            aria-hidden
          />
        </Link>
      )}

      <h2 className="mt-12 font-display text-sm font-semibold text-ink">Your notebooks</h2>

      <div className="mt-3 flex gap-2">
        <Input
          className="h-10 flex-1"
          placeholder="Name a new notebook"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createNotebook()}
        />
        <Button size="lg" disabled={creating || newName.trim() === ""} onClick={createNotebook}>
          {creating ? <Loader2 className="animate-spin" /> : <Plus />}
          Create
        </Button>
      </div>
      {createError && <p className="mt-2 text-sm text-status-error">{createError}</p>}

      {loading ? (
        <ul className="mt-4 space-y-2">
          {[0, 1].map((i) => (
            <li key={i} className="rounded-lg border border-line bg-paper-raised px-4 py-3.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="mt-2 h-3 w-24" />
            </li>
          ))}
        </ul>
      ) : loadError ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-status-error">
          Your notebooks could not be loaded. Refresh the page to try again.
        </p>
      ) : mine.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-muted">
          No notebooks of your own yet. Name one above and add your first source.
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {mine.map((nb) => (
            <li
              key={nb.id}
              className="flex items-center gap-3 rounded-lg border border-line bg-paper-raised px-4 py-3 transition-colors hover:border-line-strong"
            >
              {renamingId === nb.id ? (
                <Input
                  autoFocus
                  aria-label="Notebook name"
                  className="h-8 flex-1"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitRename(nb.id)}
                  onBlur={() => submitRename(nb.id)}
                />
              ) : (
                <Link href={`/notebook/${nb.id}`} className="min-w-0 flex-1 group">
                  <span className="block truncate font-medium text-ink transition-colors group-hover:text-brand">
                    {nb.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    {sourceCount(nb) === 1 ? "1 source" : `${sourceCount(nb)} sources`}
                    {" · "}
                    {dateFormat.format(new Date(nb.created_at))}
                  </span>
                </Link>
              )}

              {renamingId !== nb.id && (
                <span className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-muted"
                    onClick={() => {
                      setRenamingId(nb.id);
                      setRenameValue(nb.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-muted hover:text-status-error"
                    onClick={() => setConfirming(nb)}
                  >
                    Delete
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-14 border-t border-line pt-5 text-sm text-ink-muted">
        Search quality here is measured rather than assumed: 40 hand written
        questions, answered by keyword and vector search together.{" "}
        <a
          href="https://github.com/PreetMax85/commonplace"
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
        >
          Source and numbers on GitHub
        </a>
      </footer>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this notebook?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.name} and its {sourceCount(confirming ?? ({} as Notebook))} sources
              will be deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirming;
                setConfirming(null);
                if (target) deleteNotebook(target.id);
              }}
            >
              Delete notebook
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
