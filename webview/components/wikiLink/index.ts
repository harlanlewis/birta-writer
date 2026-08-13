/**
 * Wikilink NodeView — resolved chip + in-place source editing (MAR-74).
 *
 * The `wiki_link` node holds its raw inner bytes as text CONTENT (plugins/
 * wikiLinks.ts). This view shows two faces of that content:
 *
 *   - `.wiki-link-render` — the resolved display text (contenteditable=false):
 *     the alias if the raw has one, else `target#heading`. Visible while the
 *     caret is elsewhere.
 *   - `.wiki-link-src` — the contentDOM: the raw bytes ProseMirror manages,
 *     revealed (with `[[`/`]]` bracket chrome from CSS) while the caret is
 *     inside.
 *
 * Which face shows is driven by `.wiki-link--editing`, a node DECORATION from
 * wikiLinkEdit.ts — selection state only, never a document change.
 *
 * The dataset (`data-raw`, `data-target`, `data-heading`) is repainted from the
 * content on every update, because click routing and the link popup read the
 * rendered anchor rather than the node. Repainting is what keeps them honest
 * once the raw can change under the caret.
 */
import "./wikiLink.css";
import type { Node as PMNode } from "@/pm";
import { parseWikiRaw, wikiDisplayText, wikiRawOf } from "@/plugins/wikiLinks";
import { t } from "@/i18n";

interface WikiLinkView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update: (node: PMNode) => boolean;
    selectNode: () => void;
    deselectNode: () => void;
    ignoreMutation: (mutation: MutationRecord | { type: "selection"; target: Node }) => boolean;
}

/** Repaint the display face and the routing dataset from `raw`. */
function paint(dom: HTMLElement, render: HTMLElement, raw: string): void {
    const { target, heading } = parseWikiRaw(raw);
    dom.dataset["raw"] = raw;
    dom.dataset["target"] = target;
    dom.dataset["heading"] = heading ?? "";

    if (!raw.trim()) {
        render.textContent = "";
        dom.classList.add("wiki-link--empty");
        dom.title = t("Empty wikilink — type its target");
        return;
    }
    dom.classList.remove("wiki-link--empty");
    dom.title = "";
    render.textContent = wikiDisplayText(raw);
}

export function createWikiLinkView(initialNode: PMNode): WikiLinkView {
    let currentRaw = wikiRawOf(initialNode);

    const dom = document.createElement("a");
    dom.className = "wiki-link";
    dom.dataset["type"] = "wiki-link";

    const render = document.createElement("span");
    render.className = "wiki-link-render";
    render.contentEditable = "false";

    const src = document.createElement("span");
    src.className = "wiki-link-src";
    src.spellcheck = false;

    dom.append(render, src);
    paint(dom, render, currentRaw);

    return {
        dom,
        contentDOM: src,
        update(node: PMNode): boolean {
            if (node.type !== initialNode.type) {
                return false;
            }
            const next = wikiRawOf(node);
            if (next !== currentRaw) {
                currentRaw = next;
                paint(dom, render, next);
            }
            return true;
        },
        selectNode(): void {
            dom.classList.add("wiki-link--selected");
        },
        deselectNode(): void {
            dom.classList.remove("wiki-link--selected");
        },
        // ProseMirror must see mutations in the source span (its contentDOM);
        // our own repaint of the render span and the dataset is ours to ignore.
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") {
                return false;
            }
            const target = mutation.target;
            return !(src === target || src.contains(target));
        },
    };
}
