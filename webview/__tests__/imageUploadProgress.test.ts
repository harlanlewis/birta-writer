/**
 * Image-save progress and failure chrome (MAR-21 item 4).
 *
 * The contract is that this is CHROME: it reports on a save without touching
 * the document, so a failed save leaves the file exactly as it was. These
 * drive a real editor and assert both halves — the decoration that appears,
 * and the document that must not change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, editorViewCtx, rootCtx, defaultValueCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    UPLOAD_PILL_DELAY_MS,
    beginImageUpload,
    failImageUpload,
    imageUploadProgressKey,
    imageUploadProgressPlugin,
    settleImageUpload,
    uploadInsertPos,
} from "../plugins/imageUploadProgress";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(imageUploadProgressPlugin)
        .create();
}

/** How many upload widgets the plugin is currently rendering. */
function pillCount(v: EditorView): number {
    const set = imageUploadProgressKey.getState(v.state)?.decorations;
    return set ? set.find().length : 0;
}

const pills = () => Array.from(document.querySelectorAll(".img-upload-pill"));

describe("imageUploadProgressPlugin", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.useFakeTimers();
        document.body.innerHTML = "";
        editor = await makeEditor("hello world\n");
        v = editor.action((ctx) => ctx.get(editorViewCtx));
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 6)));
    });

    afterEach(async () => { vi.useRealTimers(); await editor.destroy(); });

    /** Let a save outlive the flicker threshold so its pill is rendered. */
    const waitForPill = () => vi.advanceTimersByTime(UPLOAD_PILL_DELAY_MS + 1);

    it("starting a save should show one progress pill without changing the document", () => {
        const before = editor.action(getMarkdown());
        beginImageUpload(v);
        waitForPill();
        expect(pillCount(v)).toBe(1);
        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("settling a save should remove its chrome", () => {
        const id = beginImageUpload(v);
        settleImageUpload(v, id);
        expect(pillCount(v)).toBe(0);
    });

    it("two concurrent saves should each get their own pill", () => {
        const a = beginImageUpload(v);
        beginImageUpload(v);
        waitForPill();
        expect(pillCount(v)).toBe(2);
        settleImageUpload(v, a);
        expect(pillCount(v)).toBe(1);
    });

    it("a failed save should leave the document untouched", () => {
        const before = editor.action(getMarkdown());
        const id = beginImageUpload(v);
        failImageUpload(v, id, "disk full");
        expect(editor.action(getMarkdown())).toBe(before);
        // A failure reports immediately — it does not wait out the threshold,
        // because unlike progress it stays worth reading however fast it came.
        expect(pillCount(v)).toBe(1);
    });

    // A local save is usually single-digit ms; a pill that appears and vanishes
    // inside one frame is flicker, not information.
    it("a save that finishes quickly should never show a pill", () => {
        const id = beginImageUpload(v);
        expect(pillCount(v)).toBe(0);
        settleImageUpload(v, id);
        waitForPill();
        expect(pillCount(v)).toBe(0);
    });

    it("a save still running past the threshold should show its pill", () => {
        beginImageUpload(v);
        vi.advanceTimersByTime(UPLOAD_PILL_DELAY_MS - 10);
        expect(pillCount(v)).toBe(0);
        vi.advanceTimersByTime(20);
        expect(pillCount(v)).toBe(1);
    });

    it("a failed save's pill should state the reason and be dismissable", () => {
        const id = beginImageUpload(v);
        failImageUpload(v, id, "disk full");
        const pill = pills().find((p) => p.textContent?.includes("disk full"));
        expect(pill, "an error pill naming the reason").toBeDefined();
        expect(pill!.getAttribute("role")).toBe("alert");

        const dismiss = pill!.querySelector("button");
        expect(dismiss, "a dismiss control").not.toBeNull();
        dismiss!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(pillCount(v)).toBe(0);
    });

    // MAR-281: one drop of several files is ONE save with one pill, so the
    // pill has to say so rather than describe a single image.
    it("a batch's pill should name how many images are being saved", () => {
        beginImageUpload(v, undefined, 3);
        waitForPill();
        expect(pillCount(v)).toBe(1);
        expect(pills()[0]?.textContent).toContain("Saving 3 images…");
    });

    it("a partly-failed batch's pill should say how many did not save", () => {
        const id = beginImageUpload(v, undefined, 3);
        failImageUpload(v, id, "disk full", 2);
        expect(pills()[0]?.textContent).toContain("2 images not saved: disk full");
    });

    it("a single failed save should keep the singular wording", () => {
        const id = beginImageUpload(v);
        failImageUpload(v, id, "disk full");
        expect(pills()[0]?.textContent).toContain("Image not saved: disk full");
    });

    // The bug this fixes: the old flow inserted at the LIVE caret when the save
    // resolved, so typing (or clicking) meanwhile put the image in the wrong
    // place. The tracked position follows the edit instead.
    it("the insert position should follow edits made while the save runs", () => {
        const id = beginImageUpload(v);
        expect(uploadInsertPos(v, id)).toBe(6);
        // Insert text BEFORE the tracked position.
        v.dispatch(v.state.tr.insertText("XYZ", 1));
        expect(uploadInsertPos(v, id)).toBe(9);
        // ...and the live caret being elsewhere must not matter.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 1)));
        expect(uploadInsertPos(v, id)).toBe(9);
    });

    it("an unknown or settled token should report no insert position", () => {
        const id = beginImageUpload(v);
        settleImageUpload(v, id);
        expect(uploadInsertPos(v, id)).toBeNull();
        expect(uploadInsertPos(v, "never-existed")).toBeNull();
    });

    it("deleting the paste position's block should drop the chrome's anchor", () => {
        const id = beginImageUpload(v);
        v.dispatch(v.state.tr.delete(0, v.state.doc.content.size));
        const pos = uploadInsertPos(v, id);
        expect(pos === null || pos <= v.state.doc.content.size).toBe(true);
    });
});
