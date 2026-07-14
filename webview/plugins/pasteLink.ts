/**
 * Paste-a-URL-onto-a-selection → link the selection.
 *
 * Pasting a URL over a non-empty selection normally REPLACES the selected text
 * with the raw URL — almost never the intent. Every mainstream editor (Docs,
 * Word, Notion, GitHub) instead wraps the selection in a link to that URL. This
 * plugin does the same: it keeps the selected text, adds a `link` mark carrying
 * the pasted URL, and opens the link edit palette so the user can see and fix
 * exactly what was applied.
 *
 * Detection is deliberately narrow (see detectPastedLinkTarget): a single
 * whitespace-free token that is a scheme URL (https://…, mailto:…) or a bare web
 * domain (example.com, www.foo.com/path). Anything else — a workspace path, a
 * markdown/wikilink payload, multi-word text — falls through to a normal paste,
 * because a false positive silently mangles an ordinary paste-to-replace.
 *
 * We add the link with tr.addMark rather than reusing createLinkifyTr's
 * delete+reinsert (linkInputRule.ts): addMark preserves any inline formatting
 * inside the selection, and leaves a single history step so one undo removes it.
 */
import { Plugin } from "@milkdown/prose/state";
import type { EditorState } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";
import { openLinkEditor } from "@/components/linkPopup";

/** Scheme URL (https://…, ftp://…, and the authority-less mailto:). */
const SCHEME_URL_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)\S+$/;

/** Bare web domain: host with ≥1 dot, optional leading www., optional path/query. */
const BARE_DOMAIN_REGEX = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

/**
 * File extensions that make a "host.tld" shape a pasted FILENAME, not a domain.
 * In a markdown editor these are the realistic collisions (`notes.md`,
 * `diagram.png`), so a bare token whose host ends in one is never auto-linked.
 */
const DOC_EXTENSIONS = new Set([
    "md", "markdown", "txt", "png", "jpg", "jpeg", "gif",
    "svg", "pdf", "csv", "json", "yaml", "yml",
]);

/**
 * The href to apply when this clipboard text is pasted over a selection, or null
 * to paste normally. Pure and exported so the truth table is unit-testable
 * (the paste wiring itself needs the e2e Chromium harness).
 */
export function detectPastedLinkTarget(clipboard: string): string | null {
    const s = clipboard.trim();
    // Must be a single token: internal whitespace/newline means prose, not a URL.
    if (!s || /\s/.test(s)) { return null; }
    // Bracket/atom characters mean a markdown or wikilink payload ([x](y),
    // [[Page]]) or an inline atom — the user already expressed link intent, so
    // don't wrap the selection with the payload as an href.
    if (/[[\]￼]/.test(s)) { return null; }

    if (SCHEME_URL_REGEX.test(s)) { return s; }

    if (BARE_DOMAIN_REGEX.test(s)) {
        const host = s.split(/[/?#]/, 1)[0] ?? s;
        const tld = host.split(".").pop()?.toLowerCase() ?? "";
        if (DOC_EXTENSIONS.has(tld)) { return null; }
        return s;
    }

    return null;
}

/** True when any text node in [from, to) carries a mark of the named type. */
function rangeHasMark(state: EditorState, from: number, to: number, markName: string): boolean {
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
        if (found) { return false; }
        if (node.isText && node.marks.some((m) => m.type.name === markName)) {
            found = true;
        }
        return undefined;
    });
    return found;
}

export const pasteLinkPlugin = $prose(() =>
    new Plugin({
        props: {
            handlePaste(view, event) {
                const { state } = view;
                const linkType = state.schema.marks["link"];
                if (!linkType) { return false; }

                const { selection } = state;
                if (selection.empty) { return false; }
                const { from, to, $from, $to } = selection;

                // Single textblock only: a link mark spanning block boundaries is
                // meaningless. Never inside code (block or inline).
                if (!$from.sameParent($to)) { return false; }
                if ($from.parent.type.spec.code) { return false; }
                if (rangeHasMark(state, from, to, "link")) { return false; } // no double-wrap
                // Inline code inside the selection: linkifying it would be wrong.
                let hasCode = false;
                state.doc.nodesBetween(from, to, (node) => {
                    if (node.isText && node.marks.some((m) => m.type.spec.code)) { hasCode = true; }
                });
                if (hasCode) { return false; }

                const clipboard = event.clipboardData?.getData("text/plain") ?? "";
                const href = detectPastedLinkTarget(clipboard);
                if (!href) { return false; }

                const selectedText = state.doc.textBetween(from, to);
                view.dispatch(
                    state.tr.addMark(from, to, linkType.create({ href, title: null })),
                );

                // Anchor the palette at the now-linked range (coordsAtPos returns
                // viewport coords, matching the popup's positioning); fall back to
                // no palette when measurement fails (jsdom / detached view).
                try {
                    const start = view.coordsAtPos(from);
                    const end = view.coordsAtPos(to, -1);
                    openLinkEditor({
                        view,
                        anchorRect: {
                            left: Math.min(start.left, end.left),
                            right: Math.max(start.right, end.right),
                            top: Math.min(start.top, end.top),
                            bottom: Math.max(start.bottom, end.bottom),
                        },
                        from,
                        to,
                        text: selectedText,
                        href,
                    });
                } catch { /* link is applied; palette is a non-essential confirm */ }

                return true; // handled: prevent the default replace-with-URL paste
            },
        },
    }),
);
