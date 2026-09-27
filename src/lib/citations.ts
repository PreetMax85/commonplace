// Citation markers in a generated answer. The prompt asks for [n], but gpt-oss
// often cites in its own training format instead, "【n】" or "【n†L1-L4】", so
// all three are accepted. Only one or two digits count: an answer never has
// more than a handful of passages, and a bracketed year like [1890] quoted from
// a source is not a citation.
//
// Global, so it works with both matchAll and replace. Both start from the
// beginning of the string every time, so sharing it is safe.
export const CITATION_MARKER = /[[【](\d{1,2})(?:†[^\]】\s]{0,32})?[\]】]/g;

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
  for (const [, digits] of answer.matchAll(CITATION_MARKER)) {
    markers++;
    const n = Number(digits);
    const list = n >= 1 && n <= passages ? valid : outOfRange;
    if (!list.includes(n)) list.push(n);
  }
  return { valid, outOfRange, markers };
}
