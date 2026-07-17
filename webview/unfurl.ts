/**
 * unfurl.ts
 *
 * Webview half of paste-unfurl (MAR-178). Owns the pending-request bookkeeping
 * and the live-doc find-and-upgrade that turns an optimistically-inserted bare
 * `[url](url)` into `[title](url)` once the extension replies with the page
 * title.
 *
 * The paste hook (webview/plugins/pasteLink.ts) inserts the bare link
 * synchronously (one history step), fires `notifyUnfurl`, and registers here.
 * The reply lands via messageHandlers → handleUnfurlResult. This module mirrors
 * the pending-promise pattern of webview/imageUpload.ts, but resolves to
 * "keep the bare link" on timeout (like handleGetProjectImages) rather than
 * rejecting — a failed unfurl is not an error the user should see.
 *
 * WHY search the live doc instead of reusing the captured position: the
 * document can change between paste and reply (the user keeps typing, or an
 * `externalUpdate` sync applies a diff), so a stale `from/to` may point at the
 * wrong content. We instead re-read the LIVE view at reply time and locate the
 * un-upgraded bare link by SHAPE — a text node carrying a `link` mark whose
 * href === url AND whose text === url. That shape is unique to a bare,
 * not-yet-upgraded link (after the upgrade the text is the title, so text ≠
 * url), which makes the search idempotent and drift-proof. If nothing matches
 * (the user deleted it, or it moved out from under us), we skip silently.
 */

import type { EditorView, Node as ProseNode } from "./pm";

/**
 * How long the webview waits for an `unfurlResult` before giving up and keeping
 * the bare link. The extension's own fetch timeout is shorter (5s), so this is
 * only a backstop for a genuinely lost reply (e.g. the panel was disposed
 * mid-flight). Longer than the fetch timeout on purpose.
 */
const UNFURL_REPLY_TIMEOUT_MS = 15000;

type PendingUnfurl = {
    /** The pasted href; also the bare link's text before upgrade. */
    url: string;
    /** Doc position where the bare link was inserted, used to break ties. */
    pos: number;
    timeoutId: ReturnType<typeof setTimeout>;
};

const _pending = new Map<string, PendingUnfurl>();

/**
 * Record a pending unfurl and arm its backstop timeout. On timeout we simply
 * drop the entry: the bare `[url](url)` the paste hook already inserted stays as
 * the final, offline-safe result — there is nothing to undo or clean up.
 */
export function registerPendingUnfurl(id: string, url: string, pos: number): void {
    const timeoutId = setTimeout(() => {
        _pending.delete(id);
    }, UNFURL_REPLY_TIMEOUT_MS);
    _pending.set(id, { url, pos, timeoutId });
}

/**
 * Handle an `unfurlResult` reply. A null `title` (offline / no title / failure)
 * means keep the bare link, so we only clean up. A non-null `title` upgrades the
 * matching bare link's TEXT in the live document.
 */
export function handleUnfurlResult(
    view: EditorView | null,
    id: string,
    title: string | null,
): void {
    const pending = _pending.get(id);
    if (!pending) { return; }
    clearTimeout(pending.timeoutId);
    _pending.delete(id);

    if (title === null || !view) { return; }
    upgradeBareLinkToTitle(view, pending.url, pending.pos, title);
}

/**
 * Locate the un-upgraded bare link to upgrade: a text node carrying a `link`
 * mark whose href === url AND whose text === url. Returns the doc range
 * [from, to) of the occurrence NEAREST `nearPos` (several bare links to the
 * same URL can coexist), or null when none matches. Pure and exported so the
 * drift-handling can be unit-tested against a real ProseMirror doc.
 */
export function findBareLinkRange(
    doc: ProseNode,
    url: string,
    nearPos: number,
): { from: number; to: number } | null {
    let best: { from: number; to: number } | null = null;
    let bestDistance = Infinity;
    doc.descendants((node: ProseNode, pos: number) => {
        if (!node.isText) { return; }
        // Text of an un-upgraded bare link equals the href exactly.
        if (node.text !== url) { return; }
        const hasBareLink = node.marks.some(
            (m) => m.type.name === "link" && m.attrs["href"] === url,
        );
        if (!hasBareLink) { return; }
        const from = pos;
        const to = pos + node.nodeSize;
        const distance = Math.abs(from - nearPos);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = { from, to };
        }
        return;
    });
    return best;
}

/**
 * Replace the matched bare link's text with `title`, keeping the `link` mark
 * (href unchanged). Built from the LIVE state and dispatched with
 * `addToHistory: false`, so the swap is not independently undoable — one undo
 * then removes the whole link, preserving the paste's "one undo removes it"
 * spirit. Ordinary transaction otherwise, so the titled link saves normally
 * through the sync scheduler.
 */
function upgradeBareLinkToTitle(
    view: EditorView,
    url: string,
    nearPos: number,
    title: string,
): void {
    const range = findBareLinkRange(view.state.doc, url, nearPos);
    if (!range) { return; }
    const linkType = view.state.schema.marks["link"];
    if (!linkType) { return; }

    const tr = view.state.tr;
    tr.insertText(title, range.from, range.to);
    // Re-assert the link mark over the new title text: replacement text does not
    // reliably inherit the mark, so add it explicitly (href preserved).
    tr.addMark(range.from, range.from + title.length, linkType.create({ href: url, title: null }));
    tr.setMeta("addToHistory", false);
    view.dispatch(tr);
}
