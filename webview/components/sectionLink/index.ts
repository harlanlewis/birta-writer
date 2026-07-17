/**
 * components/sectionLink/index.ts
 *
 * The "Link to section" picker (MAR-176): a live, keyboard-navigable list of the
 * document's headings that inserts a standard markdown anchor link
 * `[text](#slug)` to the one you choose. No new node/mark type — the output is
 * plain markdown that round-trips (phase-0 line).
 *
 * How it composes with what already exists, rather than rebuilding any of it:
 *   - Headings come from `collectDocHeadings` — the same doc-model walk the TOC
 *     uses, so the picker and the outline can never disagree.
 *   - Slugs come from `collectDocHeadings` + `slugifyHeadings` — the SAME
 *     model-sourced pair linkPopup's resolveAnchorHeading resolves `#slug`
 *     clicks with, so producer and resolver agree on the slug even for a
 *     heading carrying an inline atom, and a link to the second "Overview"
 *     carries the matching `-N` suffix and jumps to the right one.
 *   - The dropdown IS the workspace-file suggest widget (createSuggestMenuFromRows),
 *     so arrow/Enter navigation, hover, and viewport-flip placement come for free.
 *   - After a pick we apply the link, then open the standard link editor
 *     (openLinkEditor) at the applied range to confirm/tweak — the pasteLink
 *     pattern. Apply-then-confirm (not prefill-and-let-commit-insert) is what
 *     openLinkEditor's own semantics require; see applyPick for why.
 */
import type { EditorView } from "@/pm";
import { collectDocHeadings } from "@/utils/headingUtils";
import { slugifyHeadings } from "@/utils/slug";
import {
    createSuggestMenuFromRows,
    type LinkSuggestMenu,
    type SuggestMenuAnchor,
} from "@/components/pathLink/linkTargetComplete";
import { openLinkEditor } from "@/components/linkPopup";
import { onOutsideClick } from "@/ui/outsideClick";
import { t } from "@/i18n";

/** The one live picker, so a second invocation replaces the first (never stacks). */
let activePicker: { close: () => void } | null = null;

/** What a rendered row resolves to when picked. */
interface HeadingPick {
    /** The bare slug (no leading `#`); the href is `#${slug}`. */
    slug: string;
    /** The heading's own text — the link text when the caret is empty. */
    title: string;
}

/**
 * Ensures every row's display string is unique, so the pick-by-display-text map
 * below is injective even when two headings share a title AND a level. The
 * suggest widget reports a pick by its display TEXT, so two identical rows would
 * be indistinguishable; a "(2)", "(3)", … suffix on the later duplicate keeps
 * them apart (and reads as a helpful hint that the heading repeats). Purely a
 * display concern — the href still comes from slugifyHeadings' `-N` suffix.
 */
function uniqueDisplay(base: string, used: Set<string>): string {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    let n = 2;
    while (used.has(`${base} (${n})`)) {
        n++;
    }
    const display = `${base} (${n})`;
    used.add(display);
    return display;
}

/**
 * Open the section-link picker for the current selection/caret. A no-op-safe
 * entry point: with no headings it shows a quiet "no headings" state rather than
 * crashing or silently doing nothing.
 */
export function openSectionLinkPicker(view: EditorView): void {
    // Replace any picker already up (e.g. the command fired twice).
    activePicker?.close();

    // Snapshot the target range NOW, before any menu chrome can shift focus.
    // A selection spanning several textblocks cannot become one inline link
    // without fusing their texts, so clamp `to` into the first textblock —
    // exactly what the toolbar's insert-link prompt does (openLinkPrompt).
    const { selection } = view.state;
    const from = selection.from;
    let to = selection.to;
    const $from = selection.$from;
    if ($from.parent.isTextblock) {
        const firstBlockEnd = $from.end();
        if (to > firstBlockEnd) {
            to = firstBlockEnd;
        }
    }
    const selectionText = from !== to ? view.state.doc.textBetween(from, to) : "";

    const headings = collectDocHeadings(view.state.doc);
    const slugs = slugifyHeadings(headings.map((h) => h.text));

    // Anchor the dropdown at the caret (start of the range). coordsAtPos throws
    // in jsdom / on a detached view — fall back to the editor's own box, like
    // the toolbar prompt and pasteLink do.
    let anchor: SuggestMenuAnchor;
    try {
        const c = view.coordsAtPos(from);
        anchor = { left: c.left, top: c.bottom + 4, flipTop: c.top - 4 };
    } catch {
        const r = view.dom.getBoundingClientRect();
        anchor = { left: r.left + 8, top: r.top + 8 };
    }

    // Build rows + the display→pick map. An empty document (no headings) shows a
    // single, inert "no headings" row so the command has visible feedback.
    const pickByDisplay = new Map<string, HeadingPick>();
    let rowDefs: Array<{ text: string; title?: string }>;
    if (headings.length === 0) {
        rowDefs = [{ text: t("No headings in this document") }];
    } else {
        const used = new Set<string>();
        rowDefs = [];
        headings.forEach((h, i) => {
            // A heading whose title slugifies to "" is UNADDRESSABLE — an
            // emoji/punctuation-only title (e.g. "## 🚀") produces no anchor, so
            // the href would be a bare "#" that resolves to nothing (or the
            // wrong heading). Don't offer it; a dead link is worse than no row.
            if (slugs[i] === "") {
                return;
            }
            // Indent by heading level (nbsp keeps the leading space from
            // collapsing) so the list reads as the document's outline.
            const indent = "  ".repeat(Math.max(0, h.level - 1));
            const display = uniqueDisplay(indent + h.text, used);
            pickByDisplay.set(display, { slug: slugs[i], title: h.text });
            rowDefs.push({ text: display, title: h.text });
        });
        // Every heading was unaddressable (all empty-slug): fall back to the
        // same inert empty-state row an empty document shows.
        if (rowDefs.length === 0) {
            rowDefs = [{ text: t("No headings in this document") }];
        }
    }

    let menu: LinkSuggestMenu | null = null;
    let outsideOff: (() => void) | null = null;

    function close(): void {
        view.dom.removeEventListener("keydown", onKeydown, true);
        view.dom.removeEventListener("blur", close);
        outsideOff?.();
        outsideOff = null;
        menu?.destroy();
        menu = null;
        if (activePicker && activePicker.close === close) {
            activePicker = null;
        }
    }

    function applyPick(display: string): void {
        const pick = pickByDisplay.get(display);
        close();
        if (!pick) {
            return; // the inert "no headings" row
        }
        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) {
            return;
        }
        // The link text defaults to the selected text; with only a caret it
        // defaults to the heading's own title.
        const text = selectionText || pick.title;
        const href = `#${pick.slug}`;

        // Apply the link NOW, then open the editor to confirm/tweak — the
        // pasteLink pattern. Applying-then-confirming (rather than opening the
        // editor prefilled and letting its commit insert) is what openLinkEditor's
        // semantics require: applyEdit skips a commit whose fields equal the
        // prefill (its "don't rewrite an untouched link" guard), so a pure
        // prefill-then-Enter would be a no-op. One transaction = one undo step.
        let tr = state.tr;
        let linkedTo = to;
        if (from === to) {
            // Caret: insert the heading title as freshly linked text.
            tr = tr.replaceWith(from, to, state.schema.text(text));
            linkedTo = from + text.length;
            tr = tr.addMark(from, linkedTo, linkType.create({ href, title: null }));
        } else {
            // Selection: keep the selected text, mark it as the link.
            tr = tr.addMark(from, to, linkType.create({ href, title: null }));
        }
        view.dispatch(tr);

        // Re-measure the now-linked range for the editor's anchor (its rect
        // fallback covers jsdom / a detached view). coordsAtPos reads the live
        // (post-dispatch) view, so it measures the linked range.
        let anchorRect: { left: number; right: number; top: number; bottom: number };
        try {
            const start = view.coordsAtPos(from);
            const end = view.coordsAtPos(linkedTo, -1);
            anchorRect = {
                left: Math.min(start.left, end.left),
                right: Math.max(start.right, end.right),
                top: Math.min(start.top, end.top),
                bottom: Math.max(start.bottom, end.bottom),
            };
        } catch {
            const r = view.dom.getBoundingClientRect();
            anchorRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }

        // Open the link editor prefilled at the applied range so the user can
        // confirm (Enter), tweak the text, or repoint it. Its format switch
        // auto-hides for a `#slug` target, so a section link stays plain
        // markdown. Escape/click-away leave the already-applied link in place.
        openLinkEditor({ view, anchorRect, from, to: linkedTo, text, href });
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.isComposing || !menu) {
            return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            menu.moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            // Tab accepts like Enter (matches caretSuggest). A row is always
            // pre-highlighted (moveActive(1) below), so this picks it. Treating
            // Tab as accept also stops it falling through to ProseMirror, which
            // would INDENT the list item the picker was opened inside while
            // leaving the picker open (UI-2).
            if (menu.pickActive()) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            } else {
                close();
            }
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            close();
            return;
        }
        // A bare modifier press (holding Shift/Ctrl/Alt/Meta before a chord) is
        // not a stray key — ignore it so the chord it precedes still composes.
        if (
            e.key === "Shift" ||
            e.key === "Control" ||
            e.key === "Alt" ||
            e.key === "Meta"
        ) {
            return;
        }
        // Any OTHER key closes the picker and proceeds to the editor. The fixed
        // heading list has no type-to-filter, so typing here never did anything
        // useful; but left open, a stray keystroke could mutate the doc and make
        // applyPick's snapshotted from/to range stale (FID-3). We do NOT
        // preventDefault, so the key reaches the editor as normal input — closing
        // first just eliminates the stale-range window.
        close();
    }

    menu = createSuggestMenuFromRows(rowDefs, anchor, applyPick);
    if (!menu) {
        return; // nothing to show (rowDefs is never empty, but be defensive)
    }
    // Pre-highlight the first row so plain Enter confirms it (the calc menu's
    // autoActivate pattern) — a deliberate list, unlike an autocomplete where
    // Enter must keep its editing meaning.
    menu.moveActive(1);

    // Capture phase on the editor DOM: the editor keeps focus (the menu's own
    // mousedown preventDefaults), so its keydowns arrive here before any
    // ProseMirror keymap can act on Enter/arrows.
    view.dom.addEventListener("keydown", onKeydown, true);
    view.dom.addEventListener("blur", close);
    outsideOff = onOutsideClick(() => [menu?.el], close);

    activePicker = { close };
}
