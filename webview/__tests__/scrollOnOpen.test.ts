/**
 * Opening a file lands at the top; a view coming back lands where it was.
 *
 * The two were one bag, so a file opened months later opened wherever it was
 * last read. Confirmed against the running Mac app before it was written down:
 * the same note, launched with an offset of 900 remembered for its path and
 * with none, opened at 900 and at 0.
 *
 * The seam is WHICH bag the offset comes from. `msg.viewState` is the host's
 * PER-FILE memory: it outlives the view, so every open would inherit it. The
 * live bag (`getState`) belongs to THIS view, and survives a tab hide, a
 * webview revival and a settings reload while being empty for a file being
 * opened. `ViewStateOnOpen` in Swift is the other half: the Mac app's
 * `acquireVsCodeApi` shim seeds the live bag from the host, so on that surface
 * the host is what decides which of the two a page load is.
 *
 * Driven through the real `init` handler rather than through a copy of its
 * merge, because a copied fixture goes on proving a rule the product no longer
 * follows and no run reports it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { rememberScrollNow } from "../scrollPersistence";

function stubDeps(): MessageHandlerDeps {
    return {
        state: {
            getEditor: () => null,
            setEditor: () => {},
            setLineMap: () => {},
            getMarkdownSource: () => "",
            setMarkdownSource: () => {},
        },
        actions: {
            placeCaretAtLine: () => {},
            scrollToDocumentLine: () => {},
            getSwitchTarget: () => undefined,
            getSelectionContext: () => null,
            setLineOffset: () => {},
            initEditor: async () => {},
            retryScroll: () => {},
            getEditorView: () => null,
            refreshToc: () => {},
            setLineNumbers: () => {},
        },
        topbarTb: null,
    };
}

/** Run the real `init` with `viewState` as the host's echo, and answer what the
 *  page then wrote into its own bag. */
async function seeded(echo: Record<string, unknown>): Promise<Record<string, unknown>> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await createMessageHandlers(stubDeps()).init!(
        { type: "init", content: "hello\n", syncVersion: 1, viewState: echo } as never,
        container,
    );
    container.remove();
    return mockVscodeApi.setState.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe("the scroll offset in the view-state bag", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
    });
    afterEach(() => { document.body.innerHTML = ""; });

    it("a file being opened should not inherit the offset the host remembered", async () => {
        const written = await seeded({ scrollY: 900, folds: ["intro"] });
        expect(written).not.toHaveProperty("scrollY");
        // Everything else in the bag is document state and SHOULD outlive the
        // view: a fold or a table width the reader set is theirs whenever the
        // document is on screen again. Refusing the whole bag would have been
        // the easy fix and the wrong one.
        expect(written.folds).toEqual(["intro"]);
    });

    it("a view coming back should keep the offset it had", async () => {
        // What a tab hide, a webview revival and a settings reload all look
        // like: the live bag is still there and wins per key.
        mockVscodeApi.getState.mockReturnValue({ scrollY: 420 });
        const written = await seeded({ scrollY: 900, folds: ["intro"] });
        expect(written.scrollY).toBe(420);
        expect(written.folds).toEqual(["intro"]);
    });

    it("an echo with no offset should be merged unchanged", async () => {
        const written = await seeded({ folds: ["intro"], tableWidths: { a: 3 } });
        expect(written).toEqual({ folds: ["intro"], tableWidths: { a: 3 } });
    });

    /**
     * The key this turns on is the one scroll persistence WRITES, and the two
     * are spelled in different files. A name that drifted apart would strip
     * nothing while every assertion above went on passing against the stripper's
     * own spelling, so the key is taken from the writer rather than repeated:
     * `rememberScrollNow` puts the live position in the bag, and whatever key it
     * used is the one an open must not inherit.
     */
    it("the key stripped should be the one scroll persistence writes", async () => {
        mockVscodeApi.getState.mockReturnValue({});
        rememberScrollNow();
        const remembered = mockVscodeApi.setState.mock.calls.at(-1)?.[0] as Record<string, unknown>;
        const keys = Object.keys(remembered);
        // The instrument: a `rememberScrollNow` that wrote nothing would leave
        // an empty bag, and every key of it would then be trivially absent.
        expect(keys).toHaveLength(1);

        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        const written = await seeded(remembered);
        expect(Object.keys(written)).not.toContain(keys[0]);
    });
});
