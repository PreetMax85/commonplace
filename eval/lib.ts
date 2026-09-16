// Shared pieces between the label checker and the eval runner.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export type Anchor =
  | { kind: "quote"; accept: string[] }
  | { kind: "time"; accept: [number, number][] };

export interface Fact {
  source: string;
  locator: string;
  anchor: Anchor;
}

export interface Question {
  id: string;
  fact: string;
  phrasing: "verbatim" | "reworded";
  question: string;
}

export interface QuestionSet {
  notebook_id: string;
  match_count: number;
  facts: Record<string, Fact>;
  questions: Question[];
}

export interface Chunk {
  id: string;
  source_id: string;
  content: string;
  metadata: Record<string, any>;
}

export function loadSet(): QuestionSet {
  return JSON.parse(readFileSync(join(here, "questions.json"), "utf8"));
}

// Curly quotes and run-together whitespace differ between a PDF text layer and
// a hand-typed quote, so both sides are flattened before they are compared.
// Line-break hyphens are deliberately left alone: the scanned Meditations layer
// holds forms like "pup- pets", and a quote crossing one would be rejected, so
// labelled passages are chosen to avoid them.
export function normalize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function resolveSources(
  set: QuestionSet,
  sources: { id: string; title: string }[]
): Map<string, string> {
  const byTitle = new Map(sources.map((s) => [s.title, s.id]));
  const wanted = new Set(Object.values(set.facts).map((f) => f.source));
  const missing = [...wanted].filter((t) => !byTitle.has(t));
  if (missing.length) {
    throw new Error(
      `Notebook ${set.notebook_id} has no source titled: ${missing.join(" | ")}`
    );
  }
  return byTitle;
}

// A chunk answers a question when it carries the labelled passage. Quotes are
// kept under the chunker's 150-character overlap, so any quote is guaranteed to
// sit whole inside at least one chunk however the boundaries move within a
// page. Transcripts are split by time rather than by character, so those labels
// are a time window and any chunk overlapping it counts. The comparison is
// strict at both ends, so two windows that meet at a point cannot both be
// credited for the same chunk.
export function matchingChunks(fact: Fact, chunk: Chunk): boolean {
  if (fact.anchor.kind === "quote") {
    const haystack = normalize(chunk.content);
    return fact.anchor.accept.some((q) => haystack.includes(normalize(q)));
  }
  const start = chunk.metadata.timestamp_start;
  const end = chunk.metadata.timestamp_end;
  if (typeof start !== "number" || typeof end !== "number") return false;
  return fact.anchor.accept.some(([from, to]) => start < to && end > from);
}
