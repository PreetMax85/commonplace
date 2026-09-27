import type { Root, Parent, RootContent } from "mdast";
import { splitCitations } from "./citations";

// Turns citation markers into `citation:n` links for the chat panel to render.
// It runs on the parsed markdown rather than the raw text, so only prose is
// touched: code of any kind, the text of the model's own links and reference
// definitions are never rewritten.
export default function remarkCitations() {
  return (tree: Root) => linkCitations(tree);
}

function linkCitations(node: Parent) {
  node.children = node.children.flatMap((child): RootContent[] => {
    if (child.type === "text") {
      return splitCitations(child.value).map((part) =>
        typeof part === "number"
          ? { type: "link", url: `citation:${part}`, children: [{ type: "text", value: `[${part}]` }] }
          : { type: "text", value: part }
      );
    }
    if (child.type !== "link" && child.type !== "linkReference" && "children" in child) {
      linkCitations(child);
    }
    return [child];
  });
}
