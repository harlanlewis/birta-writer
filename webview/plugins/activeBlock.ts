/**
 * webview/plugins/activeBlock.ts
 *
 * Stamps `bc-active` on the NodeView host of the top-level block that holds
 * the selection, so its control column (ui/blockControls.css) stays visible
 * while you're working in the block — a caret inside a table cell or a code
 * block should not require re-hovering to reach the block's controls.
 *
 * Scope is a deliberate WHITELIST of NodeView hosts (`.mw-table`,
 * `.code-block-wrapper`): a NodeView's ignoreMutation absorbs the class
 * flip, while mutating a plain ProseMirror-rendered element (a paragraph)
 * triggers the "unexpected mutation → redraw the node" trap the block menu
 * documents — which for an embed paragraph would tear down a playing
 * iframe. Embeds get the same behavior for free from their
 * `.embed-host--selected` decoration class, and images pin their column
 * open from selectNode(). Direct classList writes, not decorations: a
 * decoration rebuild here would redraw exactly the nodes we must not touch.
 */
import type { EditorView } from "../pm";
import { Plugin } from "../pm";
import { $prose } from "@milkdown/utils";

const ACTIVE_CLASS = "bc-active";
const HOST_SELECTOR = ".mw-table, .code-block-wrapper";

/** The whitelisted NodeView host for the selection's top-level block. */
function activeHost(view: EditorView): HTMLElement | null {
    try {
        const $head = view.state.selection.$head;
        const pos = $head.depth > 0 ? $head.before(1) : $head.pos;
        const dom = view.nodeDOM(pos);
        if (dom instanceof HTMLElement && dom.matches(HOST_SELECTOR)) {
            return dom;
        }
    } catch {
        /* boundary positions during teardown — nothing active */
    }
    return null;
}

export const activeBlockPlugin = $prose(() =>
    new Plugin({
        view() {
            let current: HTMLElement | null = null;
            return {
                update(view) {
                    const el = activeHost(view);
                    if (el !== current) {
                        current?.classList.remove(ACTIVE_CLASS);
                        el?.classList.add(ACTIVE_CLASS);
                        current = el;
                    } else if (el && !el.classList.contains(ACTIVE_CLASS)) {
                        // A redraw rebuilt the element's classes; restamp.
                        el.classList.add(ACTIVE_CLASS);
                    }
                },
                destroy() {
                    current?.classList.remove(ACTIVE_CLASS);
                },
            };
        },
    }),
);
