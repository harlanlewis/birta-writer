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
 *  - style      → the same chip (`.html-css-source`), raw text
 *  - editing    → a code surface: a syntax-highlighted mirror under a
 *    transparent `<textarea>`, the two-layer editor the code lightbox uses
 *
 * The rendered face is OUTPUT, not a surface (MAR-366). A document's CSS is
 * filtered rather than trusted: `<style>` never applies, and the escaping
 * `style` declarations are dropped by the hook in utils/sanitizeLoader.ts.
 * The CSP cannot do this job, because `style-src` must carry 'unsafe-inline'
 * for the editor's own styles. Nothing rendered here holds focus either: every
 * focusable descendant is given `tabindex="-1"` once sanitized, so the one way
 * into an atom is the source panel.
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
 * instead of opening the panel — the one interaction the rendered face keeps,
 * and the reason `summary` is absent from the FOCUSABLE list below.
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
import { getVisualLineCounts, updateLineNumbers } from "../codeBlock/lineNumbers";
import { openBlockSource } from "@/plugins/blockSource";
import { reportNodeViewFailure } from "@/crashReporter";
import {
    createBlockControlsColumn,
    makeBlockControlButton,
    type BlockControlButton,
    type BlockControlsColumn,
} from "@/ui/blockControls";
import { copyTextToClipboard } from "@/ui/clipboard";
import { IconCheck, IconCode, IconCopy, IconEye } from "@/ui/icons";
import { kbd, t } from "@/i18n";

/** The custom event the Mod+Enter keymap dispatches to open the panel. */
export const HTML_EDIT_EVENT = "birta:html-edit";

const COMMENT_RE = /^<!--[\s\S]*?-->$/;
/** A value that is nothing but a `<style>` element, which renders as a chip. */
const STYLE_ELEMENT_RE = /^<style[\s>][\s\S]*<\/style>$/i;
/**
 * Focusable descendants of a rendered face.
 *
 * `summary` is deliberately absent: it is focusable natively, carries no
 * attribute to rewrite, and its toggle is the one interaction the rendered
 * face keeps.
 */
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

interface HtmlView {
    dom: HTMLElement;
    ready: Promise<void>;
    stopEvent?: (event: Event) => boolean;
    ignoreMutation: () => boolean;
    destroy?: () => void;
}

/**
 * Paint the resting face for `raw` into `dom`.
 *
 * Resolves true when the face is RENDERED HTML, false when it is a chip. Only
 * the rendered face can carry block chrome: a chip already demarcates itself
 * and already reads as something to click.
 */
function paint(dom: HTMLElement, raw: string): Promise<boolean> {
    const value = raw.trim();
    const comment = COMMENT_RE.test(value);
    if (comment || STYLE_ELEMENT_RE.test(value)) {
        // Two kinds, one chip recipe (style.css). A style element has to reach
        // it explicitly: the sanitizer drops the element AND its contents, so
        // without a face of its own the node would paint as an empty span,
        // which is the silent drop the preserve-everything promise rules out.
        dom.className = comment ? "html-inline html-comment" : "html-inline html-css-source";
        // A child span, not bare textContent: the editing face hides the
        // rendered children with `> :not(.html-src-panel)`, which cannot match
        // a text node.
        const chip = document.createElement("span");
        chip.textContent = value;
        dom.replaceChildren(chip);
        dom.title = comment
            ? t("HTML comment — preserved in the file, hidden in rendered output. Click to edit.")
            : t("CSS — preserved in the file, not applied to the editor. Click to edit.");
        return Promise.resolve(false);
    }
    dom.className = "html-inline";
    dom.title = "";
    return sanitizeInto(dom, raw, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["align", "width", "height"],
        // FORBID_CONTENTS as well as FORBID_TAGS: dropping the element alone
        // would let KEEP_CONTENT spill the stylesheet into the document as
        // visible text.
        FORBID_TAGS: ["style"],
        FORBID_CONTENTS: ["style"],
    }).then(() => {
        for (const el of dom.querySelectorAll(FOCUSABLE)) {
            el.setAttribute("tabindex", "-1");
        }
        return true;
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
 *
 * The block face carries the line-number gutter a code block carries, built
 * from the same geometry (components/codeBlock/lineNumbers.ts). It is
 * unconditional there for the same reason it is unconditional on a code block:
 * `birta.lineNumbers` numbers the DOCUMENT's source lines and says in its own
 * description that a code block's interior is left to its own numbers. The
 * inline face has no gutter, because a gutter beside two words of `<sub>` is
 * wider than what it numbers.
 */
function buildSourcePanel(value: string, block: boolean): SourcePanel {
    const root = document.createElement("span");
    root.className = block ? "html-src-panel html-src-panel--block" : "html-src-panel";

    const code = document.createElement("span");
    code.className = "html-src-code";

    // The gutter is a flex sibling of the two stacked layers, so those get a
    // positioning box of their own: the textarea is stretched over the mirror
    // with `inset: 0`, which without this wrapper would cover the numbers too.
    const body = document.createElement("span");
    body.className = "html-src-body";

    const gutter = block ? document.createElement("span") : null;
    if (gutter) {
        // Its own class, not the code block's `.line-numbers-gutter`. What is
        // shared is the GEOMETRY module below, which is where the wrapped-run
        // arithmetic lives; the skin is restated in htmlView.css so the panel
        // does not depend on codeBlock.css being in the loaded graph.
        gutter.className = "html-src-gutter";
        gutter.setAttribute("aria-hidden", "true");
    }

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

    body.append(mirror, area);
    if (gutter) {
        code.appendChild(gutter);
    }
    code.appendChild(body);

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
        if (gutter) {
            // Word wrap is always on here (both layers are `pre-wrap`), so a
            // source line can occupy several visual ones and each number cell
            // has to be as tall as its wrapped run. Measure against the mirror:
            // it is the layer in normal flow, so it is the one with a width.
            updateLineNumbers(gutter, area.value, getVisualLineCounts(mirror, area.value, true));
        }
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
            // Idempotent: this runs on every keystroke, and rebuilding the
            // resting hint when no error is showing tears down and recreates a
            // laid-out row to replace it with byte-identical content.
            if (!note.classList.contains("html-src-note--error")) { return; }
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
    // Clickable chrome that hosts a live textarea, and it declares nothing:
    // with no contentDOM on this view, prosemirror-view stamps
    // `contentEditable="false"` on the root itself. That stamp is what keeps a
    // finger's contact here rather than on the prose beside it (MAR-340), and
    // a contentDOM appearing, or a `contenteditable` attribute pre-set here,
    // removes it. Pinned by behaviour in e2e/touchChromeAudit.
    const dom = document.createElement("span");
    dom.dataset["type"] = "html";
    // Fixed at creation: a changed value recreates the whole view (there is
    // deliberately no `update` — a NodeView-side repaint would wipe the
    // decoration classes PM applied to the dom, and PM skips reapplying
    // outer decorations it considers unchanged).
    const currentValue = initialNode.attrs["value"] ?? "";
    const painted = paint(dom, currentValue);
    const ready = painted.then(() => undefined);

    let panel: SourcePanel | null = null;
    /**
     * The block chrome, once mounted. The column stays on screen for the whole
     * edit rather than being swapped away with the rendered face, so the panel
     * has visible exits: without it the only ways out are Mod+Enter, Escape and
     * Mod+/, none of which the panel shows. Null on an atom that carries no
     * chrome (inline, or one of several in a paragraph), where every branch
     * below is a no-op.
     */
    let chrome: { column: BlockControlsColumn; edit: BlockControlButton } | null = null;

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
        // Back to the resting verb, and back to hover-revealed: a column pinned
        // open over a rendered block is chrome nobody asked for.
        chrome?.edit.setVerb(IconCode, t("Edit Source"));
        chrome?.column.el.classList.remove("bc-col--shown");
        view?.focus();
    };

    /** The name of an ancestor of `pos` matching `names`, innermost first. */
    const ancestor = (pos: number, names: ReadonlySet<string>): string | null => {
        const $pos = view!.state.doc.resolve(pos);
        for (let depth = $pos.depth; depth > 0; depth--) {
            const name = $pos.node(depth).type.name;
            if (names.has(name)) {
                return name;
            }
        }
        return null;
    };

    /**
     * Is the atom at `pos` in a host whose whole content is ONE source line?
     *
     * The serializer emits html bytes verbatim, bypassing the escaping text
     * nodes get, so a committed newline reaches the file as a line break and
     * ends any host that a line break ends. A table row is one line and `|`
     * delimits its cells. A heading is one line too: an ATX heading loses its
     * tail, and at a setext depth the underline lands after a line that opens
     * an HTML block, which absorbs it and destroys the heading outright.
     *
     * A paragraph is deliberately NOT here. It holds as many lines as it likes,
     * and multi-line raw HTML in one is what the block face exists to edit.
     */
    const SINGLE_LINE_HOSTS = new Set(["table", "heading"]);
    const singleLineHost = (pos: number): string | null => ancestor(pos, SINGLE_LINE_HOSTS);

    /**
     * Is the atom at `pos` the whole of its block? Such an atom is a line of
     * HTML in its own right and opens as a full-width code block; a tag inside
     * prose opens inline, where a block panel would displace the line around
     * it. Whitespace beside the atom does not count as prose.
     *
     * A single-line host is never a block, whatever it holds. The block face is
     * full-width with margins of its own, which inside a table cell widens the
     * column and pushes the row apart around a control the user is typing in,
     * and over a heading replaces the line with a panel taller than it.
     */
    const isWholeBlock = (pos: number): boolean => {
        if (singleLineHost(pos) !== null) {
            return false;
        }
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
        // Refuse, panel open, when the bytes would tear the host apart. The
        // repo's convention for content-losing gestures is refusal with a cue,
        // never a silent normalization of what the user typed.
        if (value !== currentValue) {
            const host = singleLineHost(pos);
            if (host === "table" && /[\n|]/.test(value)) {
                panel.showError(t("A table cell cannot hold a newline or an unescaped | — it would break the row"));
                return;
            }
            if (host === "heading" && value.includes("\n")) {
                panel.showError(t("A heading is one line — a line break here would split it"));
                return;
            }
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
                if (!panel && view && !openBlockSource(view)) {
                    // No opener registered for this schema. The commit has
                    // already landed and this panel is gone, so the chord read
                    // as "apply" and the promised escalation did not happen;
                    // saying so beats a silent half-action.
                    reportNodeViewFailure("html", "openBlockSource", new Error("no block-source opener"));
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
        if (chrome) {
            // Pin it rather than leaning on `:focus-within`. Focus is about to
            // land in the textarea and would reveal the column anyway, but a
            // commit blurs first and would drop the column mid-gesture.
            chrome.column.reveal();
            chrome.column.el.classList.add("bc-col--shown");
            // Same swap the code block makes between its source and its
            // rendered diagram, and it is what makes Mod+Enter optional.
            chrome.edit.setVerb(IconEye, t("Preview"));
        }
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

    /**
     * Is this atom the ONLY thing in its block?
     *
     * Stricter than isWholeBlock, which asks about the panel's shape and is
     * true of every atom in an all-HTML paragraph. Block chrome belongs to the
     * block, so a paragraph holding two atoms must not grow two of them.
     */
    const isSoleBlockAtom = (): boolean => {
        const pos = livePos();
        if (pos === null || !view) {
            return false;
        }
        let parent;
        try {
            parent = view.state.doc.resolve(pos).parent;
        } catch {
            // A position resolved against a doc this view has already fallen
            // out of. No chrome is the right answer, and it is about to be
            // rebuilt anyway.
            return false;
        }
        if (!parent.isTextblock) {
            return false;
        }
        // One pass over the siblings, and the ancestor walk only for a
        // candidate. This runs once per html atom on the MOUNT path, and a
        // prose-heavy document holds far more inline atoms than blocks, so the
        // common answer has to be the cheap one: `<sub>` in a sentence is
        // rejected here by one resolve and one pass, never reaching
        // singleLineHost's walk to the root. Same answer as
        // `isWholeBlock(pos) && exactly one html child`, in less work.
        let atoms = 0;
        let prose = false;
        parent.forEach((child) => {
            if (child.type.name === "html") {
                atoms++;
                return;
            }
            if (child.isText && (child.text ?? "").trim() === "") {
                return;
            }
            prose = true;
        });
        if (atoms !== 1 || prose) {
            return false;
        }
        return singleLineHost(pos) === null;
    };

    let copyTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Block chrome for an atom that is a set-piece in its own right: a box, so
     * rendered HTML reads as a block rather than as loose prose, and the same
     * hover-revealed control column every other rich block carries.
     *
     * Two gates, because block-ness can change without the value changing and
     * a changed value is the only thing that rebuilds this view. This one runs
     * once, at mount, and decides whether the chrome EXISTS. The paragraph's
     * own `html-block` class (plugins/imageBlocks.ts) is maintained per
     * transaction and decides whether it SHOWS, so prose typed beside the atom
     * takes the box away without anything here running again.
     */
    const mountBlockChrome = (): void => {
        if (!isSoleBlockAtom()) {
            return;
        }
        dom.classList.add("html-inline--block");
        const column = createBlockControlsColumn(dom);
        const copy = makeBlockControlButton({
            className: "html-copy-btn",
            icon: IconCopy,
            label: t("Copy Source"),
            onClick: () => {
                // The open panel's text, not the committed attr: while the
                // panel is up, what the button is beside is what the user has
                // typed, and copying the older bytes would be a quiet lie.
                copyTextToClipboard(panel?.area.value ?? currentValue);
                copy.setVerb(IconCheck, t("Copied!"));
                if (copyTimer) {
                    clearTimeout(copyTimer);
                }
                copyTimer = setTimeout(() => {
                    copy.setVerb(IconCopy, t("Copy Source"));
                    copyTimer = null;
                }, 1500);
            },
        });
        // The click-anywhere path opens the panel already; this is what makes
        // it discoverable, and what makes it reachable from the keyboard. It
        // is the same button in both directions: open swaps its verb to
        // Preview, so one control opens the source and applies it.
        const edit = makeBlockControlButton({
            className: "html-edit-btn",
            icon: IconCode,
            label: t("Edit Source"),
            onClick: () => {
                if (panel) {
                    commit();
                } else {
                    open();
                }
            },
        });
        // No `.bc-gap` between them, though the column's convention would put
        // one before an editing verb. A gap separates GROUPS, and two buttons
        // are not two groups: on a one-line block the column already overflows
        // below the box, and spacing them further reads as two unrelated
        // controls rather than one block's chrome.
        column.add(copy.button, edit.button);
        dom.appendChild(column.el);
        chrome = { column, edit };
    };
    // The catch is not decoration: `paint` rejects if the sanitizer chunk
    // fails to load, and nothing consumes `ready` in production, so a failure
    // here would otherwise be an unhandled rejection and an atom that stays
    // permanently empty with nothing said about it.
    void painted
        .then((rendered) => {
            if (rendered) {
                mountBlockChrome();
            }
        })
        .catch((error: unknown) => {
            reportNodeViewFailure("html", "paint", error instanceof Error ? error : new Error(String(error)));
        });

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
            if (copyTimer) {
                clearTimeout(copyTimer);
                copyTimer = null;
            }
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
