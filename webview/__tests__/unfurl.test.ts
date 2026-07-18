/**
 * Paste-unfurl reply handling (webview/unfurl.ts, MAR-178). Drives the REAL
 * Milkdown editor: register a pending unfurl over a bare `[url](url)`, deliver
 * an `unfurlResult`, and assert what happens to the link.
 *
 * Two modes, and the DEFAULT is advisory: a fetched title is offered and the
 * document is untouched until accepted. `birta.pasteUnfurl.autoApply` opts into
 * the silent upgrade — the mechanics of which (text replaced, href preserved,
 * `addToHistory: false` so one undo removes the whole link) are exercised by
 * the auto-apply block below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { registerPendingUnfurl, handleUnfurlResult } from "@/unfurl";
import { isUnfurlOfferOpen, __resetUnfurlOfferForTests } from "@/components/unfurlOffer";

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

describe("handleUnfurlResult — auto-apply mode (birta.pasteUnfurl.autoApply)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        __resetUnfurlOfferForTests();
        // Opt into the silent upgrade: these cases cover the apply MECHANICS.
        window.__i18n = { translations: {}, pasteUnfurlAutoApply: true } as unknown as typeof window.__i18n;
    });

    afterEach(async () => {
        await editor.destroy();
        __resetUnfurlOfferForTests();
        delete window.__i18n;
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

describe("handleUnfurlResult — advisory by default (nothing changes without consent)", () => {
    /**
     * The offer UI is a lazily-imported chunk (it can never be needed in the
     * default offline configuration), so it mounts a microtask after the reply
     * is handled. Await that before asserting on the DOM.
     */
    async function flushOffer(): Promise<void> {
        await import("@/components/unfurlOffer");
        await Promise.resolve();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        __resetUnfurlOfferForTests();
        // No autoApply key: the default is advisory.
        window.__i18n = { translations: {} } as unknown as typeof window.__i18n;
    });

    afterEach(async () => {
        await editor.destroy();
        __resetUnfurlOfferForTests();
        delete window.__i18n;
    });

    it("a fetched title should be OFFERED, leaving the document untouched", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a1", url, 1);

        handleUnfurlResult(v, "a1", "Example Domain");
        await flushOffer();

        // The whole point: the network reply did not edit the user's file.
        expect(v.state.doc.textContent).toContain(url);
        expect(v.state.doc.textContent).not.toContain("Example Domain");
        expect(isUnfurlOfferOpen()).toBe(true);
    });

    it("accepting the offer should apply the title and close it", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a2", url, 1);
        handleUnfurlResult(v, "a2", "Example Domain");
        await flushOffer();

        document.querySelector<HTMLButtonElement>(".unfurl-offer__accept")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(v.state.doc.textContent).toContain("Example Domain");
        expect(linkHref(v)).toBe(url);
        expect(isUnfurlOfferOpen()).toBe(false);
    });

    it("dismissing the offer should keep the bare link", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a3", url, 1);
        handleUnfurlResult(v, "a3", "Example Domain");
        await flushOffer();

        document.querySelector<HTMLButtonElement>(".unfurl-offer__dismiss")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(v.state.doc.textContent).toContain(url);
        expect(isUnfurlOfferOpen()).toBe(false);
    });

    it("\"Always use fetched titles\" should apply now and flip the in-session gate", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a4", url, 1);
        handleUnfurlResult(v, "a4", "Example Domain");
        await flushOffer();

        document.querySelector<HTMLButtonElement>(".unfurl-offer__always")!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Completes the current ask (leaving it unanswered would read as broken)…
        expect(v.state.doc.textContent).toContain("Example Domain");
        // …and every later reply applies without asking.
        expect(window.__i18n?.pasteUnfurlAutoApply).toBe(true);
    });

    it("a null title should offer nothing at all", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a5", url, 1);

        handleUnfurlResult(v, "a5", null);
        await flushOffer();

        expect(isUnfurlOfferOpen()).toBe(false);
        expect(v.state.doc.textContent).toContain(url);
    });

    it("a link deleted before the reply should offer nothing", async () => {
        const url = "https://example.com";
        const v = await makeEditor(`[${url}](${url})\n`);
        registerPendingUnfurl("a6", url, 1);
        // The user removed the link while the fetch was in flight.
        v.dispatch(v.state.tr.delete(0, v.state.doc.content.size));

        handleUnfurlResult(v, "a6", "Example Domain");
        await flushOffer();

        expect(isUnfurlOfferOpen()).toBe(false);
    });
});
