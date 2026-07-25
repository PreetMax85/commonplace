"use client";

import { useState } from "react";

interface RoadmapStep {
  concept: string;
  why: string;
  source_id: string;
  timestamp_start: number;
  timestamp_end: number;
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

export default function RoadmapPanel({
  notebookId,
  onOpenStep,
}: {
  notebookId: string;
  onOpenStep: (sourceId: string, metadata: { timestamp_start: number; timestamp_end: number }) => void;
}) {
  const [steps, setSteps] = useState<RoadmapStep[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    setSteps(null);
    try {
      const res = await fetch("/api/roadmap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notebookId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate roadmap");
        return;
      }
      setSteps(data.steps);
    } catch {
      setError("Failed to generate roadmap");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border-t border-line p-3.5 bg-paper-raised">
      <button
        className="text-sm font-semibold text-ink border border-line rounded-full px-4 py-2 w-full hover:border-accent hover:bg-accent-wash disabled:opacity-50 transition-colors"
        onClick={generate}
        disabled={loading}
      >
        {loading ? "Building roadmap..." : "🗺️ Generate Learning Roadmap"}
      </button>

      {error && <p className="text-xs text-status-error mt-2">{error}</p>}

      {steps && (
        <ol className="mt-3 space-y-2 max-h-64 overflow-y-auto">
          {steps.map((step, i) => (
            <li key={i} className="text-sm border border-line rounded-md p-2.5 bg-paper">
              <div className="flex justify-between items-start gap-2">
                <span className="font-medium text-ink">
                  {i + 1}. {step.concept}
                </span>
                <button
                  className="text-xs text-accent font-semibold whitespace-nowrap"
                  onClick={() =>
                    onOpenStep(step.source_id, {
                      timestamp_start: step.timestamp_start,
                      timestamp_end: step.timestamp_end,
                    })
                  }
                >
                  {formatTime(step.timestamp_start)}
                </button>
              </div>
              <p className="text-ink-faint text-xs mt-1">{step.why}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
