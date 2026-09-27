import type { Root, Parent, RootContent } from "mdast";
import { splitCitations } from "./citations";

// Turns citation markers into `citation:n` links for the chat panel to render.
// It runs on the parsed markdown rather than the raw text, so only prose is
// touched: code of any kind, the text of the model's own links and reference
// definitions are never rewritten.
export default function remarkCitations() {
  return (tree: Root) => linkCitations(tree);
}

function citationLink(n: number): RootContent {
  return { type: "link", url: `citation:${n}`, children: [{ type: "text", value: `[${n}]` }] };
}

function linkCitations(node: Parent) {
  node.children = node.children.flatMap((child): RootContent[] => {
    if (child.type === "text") {
      return splitCitations(child.value).map((part) =>
        typeof part === "number" ? citationLink(part) : { type: "text", value: part }
      );
    }
    // A line like "[1]: Sapolsky" in the answer is a reference definition, and
    // markdown then reads every [1] as a link to it rather than as text. Those
    // are still citations, not links to follow.
    if (child.type === "linkReference" && /^\d{1,2}$/.test(child.identifier)) {
      return [citationLink(Number(child.identifier))];
    }
    if (child.type !== "link" && child.type !== "linkReference" && "children" in child) {
      linkCitations(child);
    }
    return [child];
  });
}
