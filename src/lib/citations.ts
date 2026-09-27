// Citation markers in a generated answer. The prompt asks for [n], but gpt-oss
// often cites in its own training format instead, "【n】" or "【n†L1-L4】", so
// all three are accepted. Only one or two digits count: an answer never has
// more than a handful of passages, and a bracketed year like [1890] quoted from
// a source is not a citation.
const CITATION_MARKER = /[[【](\d{1,2})(?:†[^\]】\s]{0,32})?[\]】]/g;

// Inline code and fenced blocks are skipped: in `list[1]` the brackets are an
// index, not a citation. A fence still open at the end of the text counts as
// code, so a code block being streamed in is not rewritten halfway through.
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/** Replaces every citation marker outside code with `cite(n)`. */
export function replaceCitations(text: string, cite: (n: number, marker: string) => string): string {
  const inProse = (part: string) =>
    part.replace(CITATION_MARKER, (marker, digits) => cite(Number(digits), marker));
  let out = "";
  let last = 0;
  for (const code of text.matchAll(CODE)) {
    out += inProse(text.slice(last, code.index)) + code[0];
    last = code.index + code[0].length;
  }
  return out + inProse(text.slice(last));
}

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
  replaceCitations(answer, (n, marker) => {
    markers++;
    const list = n >= 1 && n <= passages ? valid : outOfRange;
    if (!list.includes(n)) list.push(n);
    return marker;
  });
  return { valid, outOfRange, markers };
}
