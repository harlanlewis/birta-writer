/**
 * HTML NodeView — rendered output with per-node source editing (MAR-14).
 *
 * The `html` node is an inline ATOM whose bytes live in its `value` attr, so
 * unlike math (source as text content, caret editing) there is nothing for
 * the caret to enter: editing happens in a source panel the view swaps in
 * over its rendered face, and a commit rewrites the attr in one transaction.
 * The serializer emits the attr verbatim, so the committed bytes are exactly
 * what reaches the file.
 *
 * Faces, per node kind:
 *  - tag HTML   → DOMPurify-sanitized rendered output (never executes; the
 *    sanitizer strips scripts and handlers, and the webview CSP is behind it)
 *  - comment    → the dimmed chip (`.html-comment`), raw text
 *  - editing    → a `<textarea>` holding the raw bytes, monospace, autosized
 *
 * Opening: click on the view, or the `birta:html-edit` custom event (the
 * Mod+Enter keymap in plugins/htmlLivePairs.ts dispatches it at the selected
 * atom's DOM, since a plugin cannot reach the NodeView instance directly).
 * A click on a rendered `<summary>` is left to the native `<details>` toggle
 * instead of opening the panel — the one rendered control DOMPurify keeps
 * interactive.
 *
 * Committing: blur or Mod+Enter commits (an unchanged value just closes);
 * Escape cancels. An emptied value deletes the node. The textarea holds
 * focus for its whole lifetime, so Escape is handled on the textarea itself
 * and the ui/escapeLayers registry is not needed — same carve-out as the
 * slash menu (open implies topmost, and blur is itself a close path).
 */
import "./htmlView.css";
import type { EditorView, Node as PMNode } from "@/pm";
import { NodeSelection } from "@/pm";
import { sanitizeInto } from "@/utils/sanitizeLoader";
import { t } from "@/i18n";

/** The custom event the Mod+Enter keymap dispatches to open the panel. */
export const HTML_EDIT_EVENT = "birta:html-edit";

const COMMENT_RE = /^<!--[\s\S]*?-->$/;

interface HtmlView {
    dom: HTMLElement;
    ready: Promise<void>;
    update?: (node: PMNode) => boolean;
    stopEvent?: (event: Event) => boolean;
    ignoreMutation: () => boolean;
    destroy?: () => void;
}

/** Paint the resting face for `raw` into `dom`; returns the sanitize handle. */
function paint(dom: HTMLElement, raw: string): Promise<void> {
    if (COMMENT_RE.test(raw.trim())) {
        dom.className = "html-inline html-comment";
        // A child span, not bare textContent: the editing face hides the
        // rendered children with `> :not(.html-src)`, which cannot match a
        // text node.
        const chip = document.createElement("span");
        chip.textContent = raw.trim();
        dom.replaceChildren(chip);
        dom.title = t("HTML comment — preserved in the file, hidden in rendered output. Click to edit.");
        return Promise.resolve();
    }
    dom.className = "html-inline";
    dom.title = "";
    return sanitizeInto(dom, raw, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["align", "width", "height"],
    });
}

/**
 * The read-only shape (no view/getPos): what the crash boundary falls back
 * to, and what callers without an editor (tests, previews) can still use.
 */
export function createHtmlView(
    initialNode: { attrs: Record<string, string> },
    view?: EditorView,
    getPos?: () => number | undefined,
): HtmlView {
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    let currentValue = initialNode.attrs["value"] ?? "";
    let ready = paint(dom, currentValue);

    let editing: HTMLTextAreaElement | null = null;

    /** The node's live position, or null when the view is stale. */
    const livePos = (): number | null => {
        const pos = getPos?.();
        return typeof pos === "number" ? pos : null;
    };

    const close = (): void => {
        if (!editing) {
            return;
        }
        const area = editing;
        editing = null;
        area.remove();
        dom.classList.remove("html-inline--editing");
        view?.focus();
    };

    const commit = (): void => {
        if (!editing || !view) {
            return;
        }
        const value = editing.value;
        const pos = livePos();
        close();
        if (pos === null || value === currentValue) {
            return;
        }
        const node = view.state.doc.nodeAt(pos);
        if (node?.type.name !== "html") {
            return;
        }
        const tr = view.state.tr;
        if (value.trim() === "") {
            tr.delete(pos, pos + node.nodeSize);
        } else {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, value });
        }
        view.dispatch(tr);
    };

    const autosize = (area: HTMLTextAreaElement): void => {
        area.rows = Math.min(12, Math.max(1, area.value.split("\n").length));
    };

    const open = (): void => {
        if (editing || !view || !getPos) {
            return;
        }
        const area = document.createElement("textarea");
        area.className = "html-src";
        area.value = currentValue;
        area.spellcheck = false;
        area.setAttribute("aria-label", t("HTML source"));
        autosize(area);
        area.addEventListener("input", () => autosize(area));
        area.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commit();
            }
        });
        area.addEventListener("blur", commit);
        editing = area;
        dom.classList.add("html-inline--editing");
        dom.appendChild(area);
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
    };

    const onClick = (event: MouseEvent): void => {
        // Leave <summary> clicks to the native <details> toggle.
        if (event.target instanceof Element && event.target.closest("summary")) {
            return;
        }
        if (!editing) {
            open();
        }
    };
    dom.addEventListener("click", onClick);
    dom.addEventListener(HTML_EDIT_EVENT, open);

    return {
        dom,
        get ready() {
            return ready;
        },
        update(node: PMNode): boolean {
            if (node.type.name !== "html") {
                return false;
            }
            const next = (node.attrs["value"] as string | undefined) ?? "";
            if (next !== currentValue) {
                currentValue = next;
                if (!editing) {
                    ready = paint(dom, next);
                }
            }
            return true;
        },
        // While the panel is open, its events are the textarea's, not
        // ProseMirror's — otherwise PM's keymaps eat every keystroke.
        stopEvent: (event: Event): boolean =>
            editing !== null && event.target === editing,
        ignoreMutation: () => true,
        destroy(): void {
            dom.removeEventListener("click", onClick);
            dom.removeEventListener(HTML_EDIT_EVENT, open);
        },
    };
}

/** Open the source panel of the html atom under a NodeSelection, if any. */
export function openSelectedHtmlEditor(view: EditorView): boolean {
    const { selection } = view.state;
    if (!(selection instanceof NodeSelection) || selection.node.type.name !== "html") {
        return false;
    }
    const dom = view.nodeDOM(selection.from);
    if (!(dom instanceof HTMLElement)) {
        return false;
    }
    dom.dispatchEvent(new CustomEvent(HTML_EDIT_EVENT));
    return true;
}
