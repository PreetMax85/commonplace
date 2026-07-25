"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface Notebook {
  id: string;
  name: string;
  created_at: string;
}

export default function Home() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function load() {
    const res = await fetch("/api/notebooks");
    setNotebooks(await res.json());
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function createNotebook() {
    if (!newName.trim()) return;
    await fetch("/api/notebooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    setNewName("");
    load();
  }

  async function deleteNotebook(id: string) {
    if (!confirm("Delete this notebook and all its sources?")) return;
    await fetch(`/api/notebooks/${id}`, { method: "DELETE" });
    load();
  }

  function startRename(nb: Notebook) {
    setRenamingId(nb.id);
    setRenameValue(nb.name);
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

  return (
    <main className="max-w-2xl mx-auto px-6 py-16">
      <h1 className="font-display text-3xl font-bold text-ink mb-8 tracking-tight">
        Notebooks
      </h1>

      <div className="flex gap-2 mb-10">
        <input
          className="border border-line rounded-lg px-4 py-2.5 flex-1 bg-paper-raised text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:ring-2 focus:ring-accent-wash transition-colors"
          placeholder="New notebook name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createNotebook()}
        />
        <button
          className="bg-accent hover:bg-accent-hover text-accent-ink font-semibold px-5 py-2.5 rounded-lg transition-colors"
          onClick={createNotebook}
        >
          Create
        </button>
      </div>

      {loading ? (
        <p className="text-ink-faint text-sm">Loading...</p>
      ) : notebooks.length === 0 ? (
        <div className="border border-dashed border-line rounded-lg py-10 text-center text-ink-muted text-sm">
          No notebooks yet.
          <br />
          Create one above to get started.
        </div>
      ) : (
        <ul className="space-y-2.5">
          {notebooks.map((nb) => (
            <li
              key={nb.id}
              className="bg-paper-raised border border-line rounded-lg px-4 py-3.5 flex justify-between items-center hover:border-line-strong transition-colors"
            >
              {renamingId === nb.id ? (
                <input
                  autoFocus
                  className="border border-accent rounded-md px-2 py-1 flex-1 mr-2 bg-paper outline-none"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitRename(nb.id)}
                  onBlur={() => submitRename(nb.id)}
                />
              ) : (
                <Link href={`/notebook/${nb.id}`} className="font-medium text-ink hover:text-accent transition-colors">
                  {nb.name}
                </Link>
              )}
              <span className="flex gap-4 text-sm">
                {renamingId !== nb.id && (
                  <button className="text-ink-faint hover:text-ink transition-colors" onClick={() => startRename(nb)}>
                    Rename
                  </button>
                )}
                <button
                  className="text-ink-faint hover:text-status-error transition-colors"
                  onClick={() => deleteNotebook(nb.id)}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
