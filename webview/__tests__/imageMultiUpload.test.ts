/**
 * Dropping/pasting SEVERAL image files at once (MAR-281).
 *
 * The bug: detection was singular, so a three-file drag inserted one image and
 * discarded the other two with no message — the drop looked like it had
 * succeeded. These drive a real editor with a stubbed extension host and pin
 * the three properties the batch has to hold, none of which a per-file insert
 * loop would give:
 *
 *   - every file lands, in DRAG order — not in the order the saves happened to
 *     resolve, which is what an as-they-arrive insert produces;
 *   - the batch is ONE undo step, because it was one gesture;
 *   - a partial failure still inserts what saved, and says how much didn't.
 *
 * The saves are resolved deliberately out of order here, since in-order
 * resolution would let a broken implementation pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { undo } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { historyPlugin } from "../plugins/history";
import { imageUploadProgressPlugin, imageUploadProgressKey } from "../plugins/imageUploadProgress";
import { UPLOAD_PILL_DELAY_MS } from "../plugins/imageUploadProgress";
import type { EditorView } from "../pm";

/** Upload ids the module under test handed to the (stubbed) extension host. */
const sent = vi.hoisted(() => [] as string[]);

vi.mock("../messaging", () => ({
    notifyUploadImage: (id: string) => { sent.push(id); },
    notifyGetProjectImages: () => {},
    // The editor's plugin stack reads the webview state bag at mount
    // (plugins/listNumbering.ts hydrates ordered-list numbering from it), so a
    // partial mock of this module has to answer it. No stored bag: an empty
    // read is the "nothing to restore" path.
    getWebviewState: () => undefined,
    setWebviewState: () => {},
}));

// `vi.mock` is hoisted above this, so it binds the stub above.
import {
    saveAndInsertImagesAt,
    handleImageUploaded,
    handleImageUploadError,
} from "../imageUpload";

const png = (name: string) =>
    new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

/** Spin the real event loop until `predicate` holds, or fail loudly. */
async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (predicate()) { return; }
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
}

/** Let the allSettled continuation run after the last save is answered. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** ProseMirror history's `newGroupDelay` default — transactions closer than
 * this merge into one undo step on their own. */
const HISTORY_GROUP_DELAY_MS = 500;

describe("saveAndInsertImagesAt — a multi-file drop", () => {
    let editor: Editor;
    let v: EditorView;
    /** The boundary between the two paragraphs of the fixture below. */
    let boundary: number;

    beforeEach(async () => {
        sent.length = 0;
        document.body.innerHTML = "";
        editor = await makeCorpusEditor("alpha\n\nbravo\n", [
            historyPlugin,
            imageUploadProgressPlugin,
        ]);
        v = editorView(editor);
        // The block boundary a drop aims at: end of the first paragraph's node.
        boundary = v.state.doc.child(0).nodeSize;
    });

    afterEach(async () => { await editor.destroy(); });

    it("three dropped files should all land, in drag order, however the saves resolve", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png"), png("c.png")], "", boundary);
        await until(() => sent.length === 3, "three save requests");

        // Deliberately backwards: completion order must not decide doc order.
        handleImageUploaded(sent[2]!, "img/c.png");
        handleImageUploaded(sent[0]!, "img/a.png");
        handleImageUploaded(sent[1]!, "img/b.png");
        await flush();

        expect(editor.action(getMarkdown()))
            .toBe("alpha\n\n![](img/a.png)\n\n![](img/b.png)\n\n![](img/c.png)\n\nbravo\n");
    });

    // The saves are spaced DELIBERATELY across ProseMirror's history grouping
    // window (`newGroupDelay`, 500 ms): inside it the history merges adjacent
    // transactions anyway, so a per-file implementation passes an unspaced
    // version of this test. Straddling the window is the case where batching
    // is what makes the guarantee — and it's the realistic one, since saves
    // that slow are exactly when a user notices undoing image by image.
    it("the batch should be one undo step even when the saves straddle the history window", async () => {
        const before = editor.action(getMarkdown());
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png"), png("c.png")], "", boundary);
        await until(() => sent.length === 3, "three save requests");
        handleImageUploaded(sent[0]!, "img/0.png");
        await new Promise((r) => setTimeout(r, HISTORY_GROUP_DELAY_MS + 100));
        handleImageUploaded(sent[1]!, "img/1.png");
        handleImageUploaded(sent[2]!, "img/2.png");
        await flush();
        expect(editor.action(getMarkdown()))
            .toBe("alpha\n\n![](img/0.png)\n\n![](img/1.png)\n\n![](img/2.png)\n\nbravo\n");

        undo(v.state, v.dispatch);
        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("a partial failure should insert what saved and report how much did not", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png"), png("c.png")], "", boundary);
        await until(() => sent.length === 3, "three save requests");
        handleImageUploaded(sent[1]!, "img/b.png");
        handleImageUploadError(sent[0]!, "Disk full");
        handleImageUploadError(sent[2]!, "Disk full");
        await flush();

        expect(editor.action(getMarkdown())).toBe("alpha\n\n![](img/b.png)\n\nbravo\n");
        const upload = imageUploadProgressKey.getState(v.state)?.uploads[0];
        expect(upload?.failedCount).toBe(2);
        expect(upload?.error).toBe("Disk full");
    });

    it("editing above the drop while the saves run should carry the batch with it", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png")], "", boundary);
        await until(() => sent.length === 2, "two save requests");
        // Type into the paragraph ABOVE: every position after it shifts. The
        // batch must land where it was dropped, not where the offset now points.
        v.dispatch(v.state.tr.insertText("XX", 1));
        sent.forEach((id, i) => handleImageUploaded(id, `img/${i}.png`));
        await flush();
        expect(editor.action(getMarkdown()))
            .toBe("XXalpha\n\n![](img/0.png)\n\n![](img/1.png)\n\nbravo\n");
    });

    it("the editor closing mid-save should insert nothing and not throw", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png")], "", boundary);
        await until(() => sent.length === 2, "two save requests");
        v.destroy();
        sent.forEach((id, i) => handleImageUploaded(id, `img/${i}.png`));
        await flush(); // an unhandled rejection here would fail the run
        let images = 0;
        v.state.doc.descendants((n) => { if (n.type.name === "image") { images++; } });
        expect(images).toBe(0);
    });

    it("the alt lifted off the payload should describe the first file only", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png")], "A cat", boundary);
        await until(() => sent.length === 2, "two save requests");
        sent.forEach((id, i) => handleImageUploaded(id, `img/${i}.png`));
        await flush();
        expect(editor.action(getMarkdown()))
            .toBe("alpha\n\n![A cat](img/0.png)\n\n![](img/1.png)\n\nbravo\n");
    });

    it("one pill should stand for the whole batch, not one per file", async () => {
        saveAndInsertImagesAt(v, [png("a.png"), png("b.png"), png("c.png")], "", boundary);
        await until(() => sent.length === 3, "three save requests");
        await new Promise((r) => setTimeout(r, UPLOAD_PILL_DELAY_MS + 20));
        const uploads = imageUploadProgressKey.getState(v.state)?.uploads ?? [];
        expect(uploads.length).toBe(1);
        expect(uploads[0]?.count).toBe(3);
        expect(document.querySelectorAll(".img-upload-pill").length).toBe(1);
    });

    it("an empty file list should do nothing at all", () => {
        const before = editor.action(getMarkdown());
        saveAndInsertImagesAt(v, [], "", boundary);
        expect(sent.length).toBe(0);
        expect(editor.action(getMarkdown())).toBe(before);
    });
});
