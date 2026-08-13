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
 *  - editing    → a code surface: a syntax-highlighted mirror under a
 *    transparent `<textarea>`, the two-layer editor the code lightbox uses
 *
 * The panel wears one of two faces. An atom alone in its block is the whole
 * line of HTML, so it opens as a full-width code block with a hint row. An
 * atom inside prose (`<sub>`, a live pair's tag) opens as an inline box that
 * hugs its bytes, because a block panel mid-sentence would displace the line
 * it is being edited in.
 *
 * Sizing is the mirror's, not a row count: the highlight layer sits in normal
 * flow and the textarea is stretched over it, so the panel is exactly as tall
 * as the wrapped source. It has to be measured this way, because a row count
 * cannot see wrapping and one long line is one row of source however many
 * rows of box it needs.
 *
 * Opening: click on the view, or the `birta:html-edit` custom event (the
 * Mod+Enter keymap in plugins/htmlLivePairs.ts dispatches it at the selected
 * atom's DOM, since a plugin cannot reach the NodeView instance directly).
 * A click on a rendered `<summary>` is left to the native `<details>` toggle
 * instead of opening the panel — the one rendered control DOMPurify keeps
 * interactive.
 *
 * Committing: blur or Mod+Enter commits (an unchanged value just closes);
 * Escape cancels. An emptied value deletes the node. Mod+/ commits and hands
 * off to the block source panel, so the raw-Markdown escape hatch is reachable
 * from inside the panel rather than doing nothing there. The textarea holds
 * focus for its whole lifetime, so Escape is handled on the textarea itself
 * and the ui/escapeLayers registry is not needed — same carve-out as the
 * slash menu (open implies topmost, and blur is itself a close path).
 */
import "./htmlView.css";
import type { EditorView } from "@/pm";
import { NodeSelection } from "@/pm";
import { sanitizeInto } from "@/utils/sanitizeLoader";
import { ensureGrammars, highlight } from "@/highlighter";
import { openBlockSource } from "@/plugins/blockSource";
import { kbd, t } from "@/i18n";

/** The custom event the Mod+Enter keymap dispatches to open the panel. */
export const HTML_EDIT_EVENT = "birta:html-edit";

const COMMENT_RE = /^<!--[\s\S]*?-->$/;

interface HtmlView {
    dom: HTMLElement;
    ready: Promise<void>;
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

/** The editing face: the code surface, plus the handful of things it is driven by. */
interface SourcePanel {
    root: HTMLElement;
    area: HTMLTextAreaElement;
    /** Repaint the highlight layer under the textarea. */
    refresh(): void;
    /** Refuse a commit in place: the reason replaces the hint. */
    showError(message: string): void;
    /** Back to the resting hint, once the user has changed the bytes. */
    clearError(): void;
}

/**
 * Build the code surface for `value`.
 *
 * Every element is a `<span>`, styled into blocks by CSS. An html atom is
 * inline, so its NodeView lives inside a paragraph, and a block-level element
 * there is invalid nesting that the browser is free to hoist out of it.
 */
function buildSourcePanel(value: string, block: boolean): SourcePanel {
    const root = document.createElement("span");
    root.className = block ? "html-src-panel html-src-panel--block" : "html-src-panel";

    const code = document.createElement("span");
    code.className = "html-src-code";

    // Under the textarea, and never a target: it exists to carry the colors
    // and to give the panel its height.
    const mirror = document.createElement("span");
    mirror.className = "html-src-mirror";
    mirror.setAttribute("aria-hidden", "true");

    const area = document.createElement("textarea");
    area.className = "html-src";
    area.value = value;
    area.spellcheck = false;
    area.autocomplete = "off";
    area.setAttribute("autocorrect", "off");
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("aria-label", t("HTML source"));

    code.append(mirror, area);

    const note = document.createElement("span");
    note.className = "html-src-note";
    const hint = (text: string): HTMLElement => {
        const span = document.createElement("span");
        span.textContent = text;
        return span;
    };
    const restingHint = (): void => {
        note.classList.remove("html-src-note--error");
        note.replaceChildren(
            hint(`${kbd("Mod-Enter")} ${t("to apply")}`),
            hint(`${kbd("Escape")} ${t("to cancel")}`),
        );
    };
    restingHint();
    root.append(code, note);

    const refresh = (): void => {
        // The trailing newline is load-bearing: a segment break at the end of a
        // block is dropped in layout, so without it the mirror is one line
        // short of the textarea whenever the source ends in one, and an empty
        // value would measure zero.
        mirror.innerHTML = `${highlight(area.value, "html")}\n`;
    };
    refresh();
    // Grammars load lazily, and until they do `highlight` returns escaped
    // plaintext. Color the panel in when they arrive; the layout is the
    // mirror's either way, so nothing moves.
    void ensureGrammars().then(refresh);

    return {
        root,
        area,
        refresh,
        showError(message: string): void {
            area.setAttribute("aria-invalid", "true");
            area.title = message;
            note.classList.add("html-src-note--error");
            note.replaceChildren(hint(message));
        },
        clearError(): void {
            area.removeAttribute("aria-invalid");
            area.title = "";
            restingHint();
        },
    };
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
    // Fixed at creation: a changed value recreates the whole view (there is
    // deliberately no `update` — a NodeView-side repaint would wipe the
    // decoration classes PM applied to the dom, and PM skips reapplying
    // outer decorations it considers unchanged).
    const currentValue = initialNode.attrs["value"] ?? "";
    const ready = paint(dom, currentValue);

    let panel: SourcePanel | null = null;

    /** The node's live position, or null when the view is stale. */
    const livePos = (): number | null => {
        const pos = getPos?.();
        return typeof pos === "number" ? pos : null;
    };

    const close = (): void => {
        if (!panel) {
            return;
        }
        const open = panel;
        panel = null;
        open.root.remove();
        dom.classList.remove("html-inline--editing", "html-inline--editing-block");
        view?.focus();
    };

    /** Is the atom at `pos` inside a table? A GFM row is one source line and
     * a `|` delimits cells, so a value carrying either would tear the row or
     * shift cells off the end on the next save (the serializer emits html
     * bytes verbatim, bypassing the escaping text nodes get). */
    const inTable = (pos: number): boolean => {
        const $pos = view!.state.doc.resolve(pos);
        for (let depth = $pos.depth; depth > 0; depth--) {
            if ($pos.node(depth).type.name === "table") {
                return true;
            }
        }
        return false;
    };

    /**
     * Is the atom at `pos` the whole of its block? Such an atom is a line of
     * HTML in its own right and opens as a full-width code block; a tag inside
     * prose opens inline, where a block panel would displace the line around
     * it. Whitespace beside the atom does not count as prose.
     */
    const isWholeBlock = (pos: number): boolean => {
        const $pos = view!.state.doc.resolve(pos);
        const parent = $pos.parent;
        if (!parent.isTextblock) {
            return true;
        }
        let hasSiblingContent = false;
        parent.forEach((child) => {
            if (child.type.name === "html") {
                return;
            }
            if (child.isText && (child.text ?? "").trim() === "") {
                return;
            }
            hasSiblingContent = true;
        });
        return !hasSiblingContent;
    };

    const commit = (): void => {
        if (!panel || !view) {
            return;
        }
        const value = panel.area.value;
        const pos = livePos();
        if (pos === null) {
            close();
            return;
        }
        // Refuse, panel open, when the bytes would corrupt a table row —
        // the repo's convention for content-losing gestures is refusal with
        // a cue, never a silent normalization of what the user typed.
        if (/[\n|]/.test(value) && value !== currentValue && inTable(pos)) {
            panel.showError(t("A table cell cannot hold a newline or an unescaped | — it would break the row"));
            return;
        }
        close();
        if (value === currentValue) {
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

    const open = (): void => {
        if (panel || !view || !getPos) {
            return;
        }
        const pos = livePos();
        const block = pos !== null && isWholeBlock(pos);
        const built = buildSourcePanel(currentValue, block);
        const { area } = built;
        area.addEventListener("input", () => {
            built.refresh();
            built.clearError();
        });
        area.addEventListener("keydown", (event) => {
            const mod = event.metaKey || event.ctrlKey;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
            } else if (event.key === "Enter" && mod) {
                event.preventDefault();
                commit();
            } else if (event.key === "/" && mod) {
                // Escalate: the same bytes, in the block's raw Markdown. A
                // refusal keeps the panel open, so only hand off once the
                // commit has actually closed it.
                event.preventDefault();
                event.stopPropagation();
                commit();
                if (!panel && view) {
                    openBlockSource(view);
                }
            }
        });
        area.addEventListener("blur", commit);
        panel = built;
        dom.classList.add("html-inline--editing");
        if (block) {
            dom.classList.add("html-inline--editing-block");
        }
        dom.appendChild(built.root);
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
    };

    const onClick = (event: MouseEvent): void => {
        // Leave <summary> clicks to the native <details> toggle.
        if (event.target instanceof Element && event.target.closest("summary")) {
            return;
        }
        if (!panel) {
            open();
        }
    };
    dom.addEventListener("click", onClick);
    dom.addEventListener(HTML_EDIT_EVENT, open);

    return {
        dom,
        ready,
        // While the panel is open, its events are the panel's, not
        // ProseMirror's — otherwise PM's keymaps eat every keystroke. The
        // whole panel, not just the textarea: a mousedown on the surface
        // around it must not move the selection out from under the edit.
        stopEvent: (event: Event): boolean =>
            panel !== null && event.target instanceof Node && panel.root.contains(event.target),
        ignoreMutation: () => true,
        destroy(): void {
            dom.removeEventListener("click", onClick);
            dom.removeEventListener(HTML_EDIT_EVENT, open);
        },
    };
}

/**
 * Commit (via blur) an open HTML source panel inside this view, if any.
 * Called at the seams that read or persist the document while the panel may
 * hold an uncommitted edit — the mode switch and the save flush — so neither
 * can act on bytes older than what the user sees in the panel.
 */
export function bankOpenHtmlPanel(view: EditorView): void {
    const active = document.activeElement;
    if (
        active instanceof HTMLTextAreaElement &&
        active.classList.contains("html-src") &&
        view.dom.contains(active)
    ) {
        active.blur();
    }
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
