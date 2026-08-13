/**
 * The Insert/Edit Link action, behind both the toolbar button and Cmd/Ctrl+K.
 *
 * It captures the caret's range and any link already on it, then hands both to
 * the singleton link editor. Two constraints shape it: a selection spanning
 * several textblocks is clamped to the first, because one inline link across
 * two blocks would have to fuse their texts; and the anchor falls back to a
 * caller-supplied element when `coordsAtPos` cannot measure (jsdom, or a
 * detached view).
 */
import { getView } from "@/pm";
import type { GetEditor } from "@/editorCommands";
import { openLinkEditor } from "../linkPopup";

/**
 * `getFallbackAnchor` supplies the element to anchor on when the selection
 * cannot be measured.
 */
export function createLinkPrompt(
    getEditor: GetEditor,
    getFallbackAnchor: () => HTMLElement,
): () => void {
    const openLinkPrompt = (): void => {
        const editor = getEditor();
        if (!editor) {
            return;
        }

        const view = editor.action((ctx) => getView(ctx));
        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) {
            return;
        }

        const capturedFrom = state.selection.from;
        let capturedTo = state.selection.to;
        let existingHref = "";
        let selectedText = "";

        // A selection spanning several textblocks (paragraphs, headings,
        // list items, ...) cannot become ONE inline link without fusing
        // the blocks' texts together. Clamp to the portion inside the
        // first textblock: the editor pre-fills and the apply covers
        // that range only, leaving the other blocks untouched.
        const $from = state.selection.$from;
        if ($from.parent.isTextblock) {
            const firstBlockEnd = $from.end();
            if (capturedTo > firstBlockEnd) {
                capturedTo = firstBlockEnd;
            }
        }
        if (capturedFrom !== capturedTo) {
            selectedText = state.doc.textBetween(capturedFrom, capturedTo);
        }
        state.doc.nodesBetween(capturedFrom, capturedTo, (node) => {
            const mark = linkType.isInSet(node.marks);
            if (mark) {
                existingHref =
                    (mark.attrs as Record<string, string>)["href"] ?? "";
            }
        });

        // Anchor the editor at the captured range (coordsAtPos returns
        // viewport coordinates, matching the popup's positioning). When
        // measurement fails (jsdom, detached view) fall back to the link
        // button / toolbar.
        let anchorRect: { left: number; right: number; top: number; bottom: number };
        try {
            const start = view.coordsAtPos(capturedFrom);
            const end = view.coordsAtPos(capturedTo, -1);
            anchorRect = {
                left: Math.min(start.left, end.left),
                right: Math.max(start.right, end.right),
                top: Math.min(start.top, end.top),
                bottom: Math.max(start.bottom, end.bottom),
            };
        } catch {
            const near = getFallbackAnchor();
            const r = near.getBoundingClientRect();
            anchorRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }

        // Open the single link editor (the hover popup) at the captured
        // range. The popup owns the transaction, the pending-range highlight,
        // and returning focus to the editor on close. It is a singleton, so a
        // second open (Cmd/Ctrl+K twice, or the button while it is up) simply
        // re-anchors the same editor rather than stacking a second one.
        openLinkEditor({
            view,
            anchorRect,
            from: capturedFrom,
            to: capturedTo,
            text: selectedText,
            href: existingHref,
        });
    };

    return openLinkPrompt;
}
