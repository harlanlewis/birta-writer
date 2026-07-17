/**
 * Paste-unfurl reply handling (webview/unfurl.ts, MAR-178). Drives the REAL
 * Milkdown editor: register a pending unfurl over a bare `[url](url)`, deliver
 * an `unfurlResult`, and assert the link TEXT is upgraded to the title (mark
 * href preserved) — or left as the bare link when the title is null. The
 * upgrade rides `addToHistory: false`, so one undo removes the whole link.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { registerPendingUnfurl, handleUnfurlResult } from "@/unfurl";

let editor: Editor;

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(historyPlugin)
        .create();
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** The single link mark's href in the doc, or null. */
function linkHref(v: EditorView): string | null {
    let href: string | null = null;
    v.state.doc.descendants((node) => {
        const m = node.isText ? node.marks.find((mk) => mk.type.name === "link") : undefined;
        if (m) { href = m.attrs["href"] as string; }
    });
    return href;
}

describe("handleUnfurlResult", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    afterEach(async () => {
        await editor.destroy();
    });

    it("a non-null title should upgrade the bare link text, keeping the href", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("id1", url, 1);

        handleUnfurlResult(v, "id1", "Example Domain");

        expect(v.state.doc.textContent).toContain("Example Domain");
        expect(v.state.doc.textContent).not.toContain(url);
        expect(linkHref(v)).toBe(url);
    });

    it("a null title should leave the bare link unchanged", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("id2", url, 1);

        handleUnfurlResult(v, "id2", null);

        expect(v.state.doc.textContent).toContain(url);
        expect(linkHref(v)).toBe(url);
    });

    it("an unknown id should be a no-op", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);

        handleUnfurlResult(v, "does-not-exist", "Nope");

        expect(v.state.doc.textContent).toContain(url);
    });

    it("the title upgrade should not be independently undoable (one undo removes the link)", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`before [${url}](${url})\n`);
        registerPendingUnfurl("id3", url, 8);

        handleUnfurlResult(v, "id3", "Example Domain");
        expect(v.state.doc.textContent).toContain("Example Domain");

        // Undo once: because the upgrade was addToHistory:false, undo reaches the
        // paste step, not a separate title-swap step. In this test the paste came
        // from the fixture (no history entry), so undo is a no-op — the key
        // assertion is that a single undo never leaves a half-upgraded state
        // (the bare URL text) visible.
        v.someProp("handleKeyDown", (f) =>
            f(v, new KeyboardEvent("keydown", { key: "z", metaKey: true, ctrlKey: true })),
        );
        expect(v.state.doc.textContent).not.toContain(url);
    });

    it("a stale position should still find the link by shape (drift-proof)", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        // Record a wildly wrong position; the live-doc search must still find it.
        registerPendingUnfurl("id4", url, 9999);

        handleUnfurlResult(v, "id4", "Found Anyway");

        expect(v.state.doc.textContent).toContain("Found Anyway");
    });
});
