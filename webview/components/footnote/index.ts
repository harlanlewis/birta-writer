import "./footnote.css";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { t } from "@/i18n";

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

/**
 * Maps every footnote label to its display number, assigned in the order the
 * REFERENCES first appear in the document (GFM footnote numbering). Labels may
 * be non-numeric (e.g. `[^long-note]`); the display number is always a 1-based
 * counter independent of the label text. Duplicate references to one label
 * share the same number. Labels that only ever appear as a definition (an
 * unused footnote) are not included — they have no reference to number.
 */
export function computeDisplayIndex(doc: PMNode): Map<string, number> {
    const map = new Map<string, number>();
    let next = 1;
    doc.descendants((node) => {
        if (node.type.name === "footnote_reference") {
            const label = (node.attrs["label"] as string) ?? "";
            if (label && !map.has(label)) {
                map.set(label, next++);
            }
        }
        return true;
    });
    return map;
}

/** The matching `footnote_definition` node + its position, or null. */
export function findDefinitionByLabel(
    doc: PMNode,
    label: string,
): { node: PMNode; pos: number } | null {
    let found: { node: PMNode; pos: number } | null = null;
    doc.descendants((node, pos) => {
        if (found) return false;
        if (
            node.type.name === "footnote_definition" &&
            ((node.attrs["label"] as string) ?? "") === label
        ) {
            found = { node, pos };
            return false;
        }
        return true;
    });
    return found;
}

/** Position of the FIRST reference to `label`, or null when none exists. */
export function findFirstReferencePos(doc: PMNode, label: string): number | null {
    let pos: number | null = null;
    doc.descendants((node, at) => {
        if (pos !== null) return false;
        if (
            node.type.name === "footnote_reference" &&
            ((node.attrs["label"] as string) ?? "") === label
        ) {
            pos = at;
            return false;
        }
        return true;
    });
    return pos;
}

/**
 * The smallest positive integer (as a string) not already used as a footnote
 * label anywhere in the document — considering BOTH references and
 * definitions so a freshly inserted footnote never collides with an existing
 * numeric or non-numeric label.
 */
export function nextFreeLabel(doc: PMNode): string {
    const used = new Set<string>();
    doc.descendants((node) => {
        if (
            node.type.name === "footnote_reference" ||
            node.type.name === "footnote_definition"
        ) {
            const label = (node.attrs["label"] as string) ?? "";
            if (label) used.add(label);
        }
        return true;
    });
    let n = 1;
    while (used.has(String(n))) n++;
    return String(n);
}

// ── Shared jump/scroll + hover popover ─────────────────────────────────────

function scrollDomIntoView(el: HTMLElement): void {
    const topbar = document.querySelector(".editor-topbar") as HTMLElement | null;
    const topbarH = topbar?.getBoundingClientRect().height ?? 40;
    const top = el.getBoundingClientRect().top + window.scrollY - topbarH - 12;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    el.classList.add("footnote-flash");
    setTimeout(() => el.classList.remove("footnote-flash"), 1200);
}

/** Jump to the definition for `label` (used by reference chip click). */
function jumpToDefinition(view: EditorView, label: string): void {
    const hit = findDefinitionByLabel(view.state.doc, label);
    if (!hit) return;
    const dom = view.nodeDOM(hit.pos);
    if (dom instanceof HTMLElement) scrollDomIntoView(dom);
}

/** Jump to the first reference for `label` (used by definition back-link). */
function jumpToFirstReference(view: EditorView, label: string): void {
    const pos = findFirstReferencePos(view.state.doc, label);
    if (pos === null) return;
    const dom = view.nodeDOM(pos);
    if (dom instanceof HTMLElement) scrollDomIntoView(dom);
}

let popupEl: HTMLElement | null = null;
function getPopup(): HTMLElement {
    if (!popupEl) {
        popupEl = document.createElement("div");
        popupEl.className = "footnote-popup";
        popupEl.style.display = "none";
        document.body.appendChild(popupEl);
    }
    return popupEl;
}

function showDefinitionPopup(view: EditorView, label: string, anchor: HTMLElement): void {
    const hit = findDefinitionByLabel(view.state.doc, label);
    const popup = getPopup();
    popup.innerHTML = "";

    const marker = document.createElement("span");
    marker.className = "footnote-popup-marker";
    marker.textContent = `[^${label}]`;
    popup.appendChild(marker);

    const body = document.createElement("span");
    body.className = "footnote-popup-body";
    body.textContent = hit
        ? hit.node.textContent.trim() || t("(empty footnote)")
        : t("No definition for this footnote");
    popup.appendChild(body);

    popup.style.display = "block";
    popup.style.visibility = "hidden";
    // Position after render so we can read the popup size.
    requestAnimationFrame(() => {
        const rect = anchor.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        let left = rect.left + window.scrollX;
        if (left + popupRect.width > window.innerWidth - 8) {
            left = window.innerWidth - popupRect.width - 8;
        }
        if (left < 8) left = 8;
        let top = rect.bottom + window.scrollY + 6;
        if (rect.bottom + popupRect.height + 8 > window.innerHeight) {
            top = rect.top + window.scrollY - popupRect.height - 6;
        }
        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
        popup.style.visibility = "visible";
    });
}

function hideDefinitionPopup(): void {
    if (popupEl) popupEl.style.display = "none";
}

// ── NodeView factories ─────────────────────────────────────────────────────

interface FootnoteReferenceView {
    dom: HTMLElement;
    update: (n: PMNode) => boolean;
    ignoreMutation: () => boolean;
    stopEvent: () => boolean;
    destroy: () => void;
}

/**
 * `footnote_reference` — an inline atom rendered as a superscript chip. The
 * displayed number is the label's position in reference order (kept in sync by
 * footnoteNumberingPlugin). Hover previews the matching definition; click jumps
 * to it.
 */
export function createFootnoteReferenceView(
    initialNode: PMNode,
    view: EditorView,
    _getPos: () => number | undefined,
): FootnoteReferenceView {
    let node = initialNode;
    const dom = document.createElement("sup");
    dom.className = "footnote-ref";
    dom.dataset["type"] = "footnote_reference";
    dom.dataset["fnRef"] = "1";

    let hoverTimer: ReturnType<typeof setTimeout> | null = null;

    const render = (): void => {
        const label = (node.attrs["label"] as string) ?? "";
        dom.dataset["label"] = label;
        const idx = computeDisplayIndex(view.state.doc).get(label);
        dom.textContent = idx !== undefined ? String(idx) : label;
        dom.title = `[^${label}]`;
    };
    render();

    dom.addEventListener("mouseenter", () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            showDefinitionPopup(view, dom.dataset["label"] ?? "", dom);
        }, 200);
    });
    dom.addEventListener("mouseleave", () => {
        if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
        hideDefinitionPopup();
    });
    dom.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideDefinitionPopup();
        jumpToDefinition(view, dom.dataset["label"] ?? "");
    });

    return {
        dom,
        update(updated: PMNode): boolean {
            if (updated.type !== node.type) return false;
            node = updated;
            render();
            return true;
        },
        ignoreMutation: () => true,
        stopEvent: () => false,
        destroy(): void {
            if (hoverTimer) clearTimeout(hoverTimer);
        },
    };
}

interface FootnoteDefinitionView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update: (n: PMNode) => boolean;
    ignoreMutation: (m: MutationRecord | { type: string; target: Node }) => boolean;
}

/**
 * `footnote_definition` — an editable block (`content: "block+"`). A
 * non-editable marker carries the display badge and a back-link to the first
 * reference; the definition body (paragraphs, lists, ...) stays fully editable
 * through the plain contentDOM.
 */
export function createFootnoteDefinitionView(
    initialNode: PMNode,
    view: EditorView,
    _getPos: () => number | undefined,
): FootnoteDefinitionView {
    let node = initialNode;

    const dom = document.createElement("div");
    dom.className = "footnote-def";
    dom.dataset["type"] = "footnote_definition";

    const marker = document.createElement("div");
    marker.className = "footnote-def-marker";
    marker.contentEditable = "false";

    const badge = document.createElement("span");
    badge.className = "footnote-def-badge";

    const backlink = document.createElement("button");
    backlink.className = "footnote-def-backlink";
    backlink.type = "button";
    backlink.textContent = "↩";
    backlink.title = t("Go to reference");
    backlink.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToFirstReference(view, (node.attrs["label"] as string) ?? "");
    });

    marker.append(badge, backlink);

    const content = document.createElement("div");
    content.className = "footnote-def-content";

    dom.append(marker, content);

    const renderBadge = (): void => {
        const label = (node.attrs["label"] as string) ?? "";
        badge.dataset["label"] = label;
        const idx = computeDisplayIndex(view.state.doc).get(label);
        badge.textContent = idx !== undefined ? String(idx) : label;
        badge.title = `[^${label}]`;
    };
    renderBadge();

    return {
        dom,
        contentDOM: content,
        update(updated: PMNode): boolean {
            if (updated.type !== node.type) return false;
            node = updated;
            renderBadge();
            return true;
        },
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") return false;
            return !content.contains(mutation.target as Node) && mutation.target !== content;
        },
    };
}
