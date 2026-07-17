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
import { Plugin } from "@/pm";
import type { EditorState } from "@/pm";
import { $prose } from "@milkdown/utils";
import { openLinkEditor } from "@/components/linkPopup";

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

export const pasteLinkPlugin = $prose(() =>
    new Plugin({
        props: {
            handlePaste(view, event) {
                const { state } = view;
                const linkType = state.schema.marks["link"];
                if (!linkType) { return false; }

                const { selection } = state;
                if (selection.empty) { return false; }

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
