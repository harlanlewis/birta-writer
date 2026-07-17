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
 *
 * Paste-unfurl (MAR-178) — pasting a bare URL onto an EMPTY selection: instead
 * of dropping the raw URL as plain text, we insert `[url](url)` (a link mark
 * over the URL text) synchronously as ONE history step, then ask the extension
 * to fetch the page title (the webview is CSP/CORS-locked, so only the
 * extension can). handlePaste is sync and cannot await the fetch, so the reply
 * arrives later as `unfurlResult` and upgrades the link TEXT to the title
 * (webview/unfurl.ts). It degrades gracefully: offline / no title / the feature
 * off → the bare link simply stays. Gated by `birta.pasteUnfurl.enabled`.
 */
import { Plugin } from "@/pm";
import type { EditorState, EditorView, MarkType } from "@/pm";
import { $prose } from "@milkdown/utils";
import { openLinkEditor } from "@/components/linkPopup";
import { notifyUnfurl } from "@/messaging";
import { registerPendingUnfurl } from "@/unfurl";

/** Scheme URL (https://…, ftp://…, and the authority-less mailto:). */
const SCHEME_URL_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)\S+$/;

/**
 * Bare web domain: labels separated by dots, optional leading www., then an
 * ALPHABETIC top-level label (≥2 letters), then an optional path/query/fragment.
 * The alphabetic-TLD requirement is what separates a real host from the many
 * `word.word` shapes a user pastes to *replace* a selection — a version tag
 * (`v1.2`), an IP (`10.0.0.1`), a media filename (`clip.mp4`) or any dotted
 * identifier all have a numeric or 1-char final label and fall through to a
 * normal paste. `example.com`, `www.foo.com/path`, `docs.foo.co.uk` still match.
 */
const BARE_DOMAIN_REGEX = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}([/?#]\S*)?$/i;

/**
 * File extensions that make a "host.tld" shape a pasted FILENAME, not a domain.
 * In a markdown/dev editor these are the realistic collisions (`notes.md`,
 * `app.ts`, `build.sh`, `main.rs`), so a bare token whose host ends in one is
 * never auto-linked. A few of these (`.sh`, `.py`, `.rs`) are also obscure
 * ccTLDs, but a lone `build.sh` pasted over a selection is overwhelmingly a
 * file here, and the rare real domain on one of them still links when pasted
 * with its scheme (`https://…`). Extensions that are also *popular* TLDs
 * (`.io`, `.co`, `.me`, `.ai`, `.dev`, `.app`) are deliberately kept OUT so
 * those domains still auto-link; numeric extensions (`.mp4`, `.mp3`) are
 * already rejected by the alphabetic-TLD rule above, as are single-char ones
 * (`.c`, `.h`).
 */
const DOC_EXTENSIONS = new Set([
    // docs / data
    "md", "markdown", "txt", "csv", "json", "yaml", "yml", "toml", "ini",
    "log", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    // images / media
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "mov", "wav",
    // web / markup / source
    "html", "htm", "css", "scss", "sass", "less", "js", "jsx", "ts", "tsx",
    "mjs", "cjs", "xml", "py", "rb", "go", "rs", "sh", "php", "java", "kt",
    "swift", "cpp", "cs", "vue", "svelte",
    // archives
    "zip", "tar", "gz", "rar",
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

/**
 * True when any text node in [from, to) already carries a `link` mark (would
 * double-wrap) or an inline-code mark (linkifying code is wrong). One walk
 * covers both bail conditions.
 */
function rangeHasLinkOrCode(state: EditorState, from: number, to: number): boolean {
    const linkType = state.schema.marks["link"];
    let blocked = false;
    state.doc.nodesBetween(from, to, (node) => {
        if (blocked) { return false; }
        if (node.isText && node.marks.some((m) => m.type === linkType || m.type.spec.code)) {
            blocked = true;
            return false;
        }
        return undefined;
    });
    return blocked;
}

/** Paste-unfurl is on by default; the flag is baked into __i18n at panel load. */
function pasteUnfurlEnabled(): boolean {
    return window.__i18n?.pasteUnfurl ?? true;
}

/** Random correlation id for one unfurl request (mirrors imageUpload's ids). */
function newUnfurlId(): string {
    return `unfurl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Empty-selection paste of a bare URL (paste-unfurl, MAR-178). Inserts
 * `[url](url)` synchronously as one history step, fires the title fetch, and
 * returns true to prevent the default plain-text paste. Returns false (plain
 * paste) when the feature is off, the clipboard isn't a bare URL, or the caret
 * is somewhere a link mark must not go (code block / inline code / inside an
 * existing link).
 */
function handleEmptySelectionPaste(
    view: EditorView,
    state: EditorState,
    linkType: MarkType,
    event: ClipboardEvent,
): boolean {
    // Feature gate first: when off, do nothing extra and never touch the
    // network (no `unfurlUrl` is ever posted).
    if (!pasteUnfurlEnabled()) { return false; }

    // Same narrow detection as the selection case: a single bare-URL token.
    const clipboard = event.clipboardData?.getData("text/plain") ?? "";
    const href = detectPastedLinkTarget(clipboard);
    if (!href) { return false; }

    const { $from } = state.selection;
    // Never inside a code block, and never where the caret's active marks are
    // code (inline code) or an existing link (no nested/adjacent link).
    if ($from.parent.type.spec.code) { return false; }
    const activeMarks = state.storedMarks ?? $from.marks();
    if (activeMarks.some((m) => m.type === linkType || m.type.spec.code)) { return false; }

    // Insert the URL text carrying a link mark = `[url](url)`. One dispatch =
    // one history step. Restoring the pre-insert stored marks keeps the link
    // from extending to whatever the user types next (mirrors createLinkifyTr).
    const from = state.selection.from;
    const tr = state.tr;
    tr.insertText(href, from);
    tr.addMark(from, from + href.length, linkType.create({ href, title: null }));
    tr.setStoredMarks([...activeMarks]);
    view.dispatch(tr);

    // Fire the fetch and register the pending upgrade. `from` breaks ties if the
    // live-doc search later finds more than one bare link to the same URL.
    const id = newUnfurlId();
    registerPendingUnfurl(id, href, from);
    notifyUnfurl(id, href);

    return true; // handled: prevent the default plain-text paste
}

export const pasteLinkPlugin = $prose(() =>
    new Plugin({
        props: {
            handlePaste(view, event) {
                const { state } = view;
                const linkType = state.schema.marks["link"];
                if (!linkType) { return false; }

                const { selection } = state;
                if (selection.empty) {
                    return handleEmptySelectionPaste(view, state, linkType, event);
                }

                // Cheapest, most selective gate first: the vast majority of
                // pastes over a selection are not a URL, so reject on the
                // clipboard token before walking the selected range at all.
                const clipboard = event.clipboardData?.getData("text/plain") ?? "";
                const href = detectPastedLinkTarget(clipboard);
                if (!href) { return false; }

                const { from, to, $from, $to } = selection;
                // Single textblock only: a link mark spanning block boundaries is
                // meaningless. Never inside code (block or inline), and never
                // over an existing link (no double-wrap).
                if (!$from.sameParent($to)) { return false; }
                if ($from.parent.type.spec.code) { return false; }
                if (rangeHasLinkOrCode(state, from, to)) { return false; }

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
