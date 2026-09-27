// Citation markers in a generated answer. The prompt asks for [n], but gpt-oss
// often cites in its own training format instead, "【n】" or "【n†L1-L4】", so
// all three are accepted. Only one or two digits count: an answer never has
// more than a handful of passages, and a bracketed year like [1890] quoted from
// a source is not a citation.
const CITATION_MARKER = /[[【](\d{1,2})(?:†[^\]】\s]{0,32})?[\]】]/g;

/** Splits text into its plain runs and the passage numbers cited between them. */
export function splitCitations(text: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let last = 0;
  for (const marker of text.matchAll(CITATION_MARKER)) {
    if (marker.index > last) parts.push(text.slice(last, marker.index));
    parts.push(Number(marker[1]));
    last = marker.index + marker[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// The chat panel finds markers in the parsed markdown, which skips code of
// every kind (remarkCitations.ts). Counting works on the raw answer instead, so
// fenced blocks and inline code, the forms an answer actually uses, are cut out
// first: in `list[1]` the brackets are an index, not a citation.
const FENCED_CODE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
const INLINE_CODE = /`[^`\n]*`/g;

export interface CitationCheck {
  // Distinct passage numbers the answer cites that were actually sent to the
  // model, in the order they first appear.
  valid: number[];
  // Distinct numbers that match no passage the model was given.
  outOfRange: number[];
  // Every marker in the answer, repeats included.
  markers: number;
}

/** Checks each marker in an answer against the `passages` numbered 1 to n. */
export function checkCitations(answer: string, passages: number): CitationCheck {
  const valid: number[] = [];
  const outOfRange: number[] = [];
  let markers = 0;
  const prose = answer.replace(FENCED_CODE, "\n").replace(INLINE_CODE, " ");
  for (const n of splitCitations(prose)) {
    if (typeof n !== "number") continue;
    markers++;
    const list = n >= 1 && n <= passages ? valid : outOfRange;
    if (!list.includes(n)) list.push(n);
  }
  return { valid, outOfRange, markers };
}
