/**
 * MAR-352 — an embed card's DOM must survive the windowed gutter chrome
 * (MAR-215) moving across its block.
 *
 * The embed widget and the block-gutter widget both sit at paragraph pos + 1.
 * prosemirror-view reuses a widget only when it finds a match at the current
 * child index (ViewTreeUpdater.placeWidget has no look-ahead), so a gutter
 * widget vanishing AHEAD of the embed widget orphans the embed's view desc:
 * the card is rebuilt from scratch at its facade, destroying a playing
 * iframe because the user scrolled. The invariant pinned here is DOM node
 * identity of the card host across window moves, in both directions — it is
 * what "a playing player is stable" reduces to in jsdom, where no layout
 * engine (and no third-party iframe) exists.
 *
 * Driven through the REAL Milkdown editor with BOTH plugins composed in
 * production order (editor.ts registers headingFold before embed, which is
 * what puts the gutter widget ahead of the card at equal side).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { embedPlugin, regateEmbeds } from "../plugins/embed";
import { foldPluginKey, headingFoldPlugin } from "../plugins/headingFold";

const ID = "dQw4w9WgXcQ";

const FILLER_BEFORE = Array.from({ length: 5 }, (_, i) => `Leading paragraph ${i}.`).join("\n\n");
const FILLER_AFTER = Array.from({ length: 5 }, (_, i) => `Trailing paragraph ${i}.`).join("\n\n");
const DOC = `# Title\n\n${FILLER_BEFORE}\n\nhttps://youtu.be/${ID}\n\n${FILLER_AFTER}\n`;

beforeEach(() => {
    window.__i18n = { translations: {}, network: true } as unknown as typeof window.__i18n;
});

afterEach(() => {
    delete window.__i18n;
    document.body.innerHTML = "";
});

/** The embed paragraph's [from, to] — the bare-link paragraph's block span. */
function embedSpan(view: EditorView): { from: number; to: number } {
    let span: { from: number; to: number } | null = null;
    view.state.doc.forEach((node, offset) => {
        if (node.textContent.startsWith("https://youtu.be/")) {
            span = { from: offset, to: offset + node.nodeSize };
        }
    });
    if (!span) {
        throw new Error("embed paragraph not found");
    }
    return span;
}

/** Dispatch a MAR-215 scroll-window commit, as observeVisibleWindow would. */
function commitWindow(view: EditorView, window: { from: number; to: number }): void {
    view.dispatch(
        view.state.tr
            .setMeta(foldPluginKey, { type: "window", window })
            .setMeta("addToHistory", false),
    );
}

/** The card host inside the embed paragraph, or null. */
function cardHost(view: EditorView): HTMLElement | null {
    return view.dom.querySelector<HTMLElement>(".embed-card-host");
}

/** The gutter widget inside the embed paragraph itself, or null. */
function embedParagraphGutter(view: EditorView): HTMLElement | null {
    const { from } = embedSpan(view);
    const dom = view.nodeDOM(from);
    return dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(".heading-fold-gutter") : null;
}

describe("MAR-352 — embed card DOM identity across gutter-window moves", () => {
    it("the card host should survive its block leaving and re-entering the chrome window", async () => {
        const editor = await makeCorpusEditor(DOC, [headingFoldPlugin, embedPlugin]);
        const view = editorView(editor);
        // Caret in the heading: away from the embed (reveal-on-caret stays
        // out of play) and inside every window this test commits (no caret
        // pin materializing the embed's block from outside the window).
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
        regateEmbeds(view);

        const host = cardHost(view);
        expect(host).not.toBeNull();
        // Premise: with no window measured, the whole document is
        // materialized, so the embed's own block carries a gutter widget
        // ahead of the card at the same position.
        expect(embedParagraphGutter(view)).not.toBeNull();

        const { from, to } = embedSpan(view);

        // The window moves off the embed's block (the user scrolled, or an
        // edit elsewhere moved it): its gutter widget vanishes.
        commitWindow(view, { from: 0, to: 3 });
        expect(embedParagraphGutter(view)).toBeNull();
        expect(cardHost(view)).toBe(host);

        // And back across it: the gutter widget reappears.
        commitWindow(view, { from, to });
        expect(embedParagraphGutter(view)).not.toBeNull();
        expect(cardHost(view)).toBe(host);

        await editor.destroy();
    });
});
