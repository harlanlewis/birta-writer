/**
 * Pasting/dropping an image FILE (MAR-277).
 *
 * The bug: copying an image from a browser puts BOTH an HTML `<img>` and the
 * file itself on the clipboard. Image detection lived in a `document`-level
 * listener, and ProseMirror's paste handler is bound to the editor element
 * inside it — so bubble order guaranteed PM went first, pasting the HTML
 * `<img>` (alt intact, remote src the webview CSP won't load → "Image not
 * found"), after which the listener saved the file and inserted a SECOND image
 * with the path but no alt. One paste, two half-broken images.
 *
 * These cover the two pure helpers plus the props' contract: an image payload
 * is CLAIMED (so PM never reaches its HTML flavor), and anything else is passed
 * straight through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { editorViewCtx } from "@milkdown/core";
import { Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { altFromHtmlFlavor, imageFilesFrom, imagePastePlugin } from "../plugins/imagePaste";
import { makeCorpusEditor } from "./helpers/moveFuzz";
import type { EditorView } from "../pm";

/**
 * A DataTransfer stand-in: jsdom's has no working items/files. A real one
 * exposes the SAME files through both lists, which is what `itemsOnly` /
 * `filesOnly` exist to vary — reading both would double every dragged file.
 */
function transfer(opts: {
    file?: File;
    files?: File[];
    html?: string;
    text?: string;
    /** Only `items` is populated (a pasted screenshot, on some platforms). */
    itemsOnly?: boolean;
    /** Only `files` is populated (`items` is empty mid-drag). */
    filesOnly?: boolean;
}): DataTransfer {
    const files = opts.files ?? (opts.file ? [opts.file] : []);
    const data: Record<string, string> = {};
    if (opts.html !== undefined) { data["text/html"] = opts.html; }
    if (opts.text !== undefined) { data["text/plain"] = opts.text; }
    return {
        items: opts.filesOnly
            ? []
            : files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
        files: opts.itemsOnly ? [] : files,
        getData: (t: string) => data[t] ?? "",
    } as unknown as DataTransfer;
}

const png = (name = "a.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
const names = (fs: File[]) => fs.map((f) => f.name);

describe("imageFilesFrom", () => {
    it("an image item should be found", () => {
        expect(imageFilesFrom(transfer({ file: png() }))[0]?.type).toBe("image/png");
    });

    it("a payload with no file should yield nothing", () => {
        expect(imageFilesFrom(transfer({ html: "<p>hi</p>", text: "hi" }))).toEqual([]);
    });

    it("a null payload should yield nothing", () => {
        expect(imageFilesFrom(null)).toEqual([]);
    });

    it("a non-image file should be ignored", () => {
        const txt = new File(["x"], "a.txt", { type: "text/plain" });
        expect(imageFilesFrom(transfer({ file: txt }))).toEqual([]);
    });

    // MAR-281: the whole point — a three-file drag is one gesture carrying
    // three images, and the singular predecessor kept only the first.
    it("every image on a multi-file payload should be returned in payload order", () => {
        const dt = transfer({ files: [png("a.png"), png("b.png"), png("c.png")] });
        expect(names(imageFilesFrom(dt))).toEqual(["a.png", "b.png", "c.png"]);
    });

    it("files present in BOTH items and files should not be counted twice", () => {
        const dt = transfer({ files: [png("a.png"), png("b.png")] });
        expect(names(imageFilesFrom(dt))).toEqual(["a.png", "b.png"]);
    });

    it("a payload carrying only items should be read", () => {
        const dt = transfer({ files: [png("a.png"), png("b.png")], itemsOnly: true });
        expect(names(imageFilesFrom(dt))).toEqual(["a.png", "b.png"]);
    });

    it("a payload carrying only files should be read", () => {
        const dt = transfer({ files: [png("a.png"), png("b.png")], filesOnly: true });
        expect(names(imageFilesFrom(dt))).toEqual(["a.png", "b.png"]);
    });

    it("non-image members of a mixed payload should be dropped, keeping the rest", () => {
        const txt = new File(["x"], "notes.md", { type: "text/markdown" });
        const dt = transfer({ files: [png("a.png"), txt, png("c.png")] });
        expect(names(imageFilesFrom(dt))).toEqual(["a.png", "c.png"]);
    });
});

describe("altFromHtmlFlavor", () => {
    it("an img's alt should be lifted off the discarded HTML flavor", () => {
        expect(altFromHtmlFlavor("<img src='x.png' alt='A person at a laptop'>"))
            .toBe("A person at a laptop");
    });

    it("html without an img should yield an empty alt", () => {
        expect(altFromHtmlFlavor("<p>no image</p>")).toBe("");
    });

    it("absent or unparseable html should yield an empty alt", () => {
        expect(altFromHtmlFlavor(null)).toBe("");
        expect(altFromHtmlFlavor("")).toBe("");
    });
});

describe("imagePastePlugin — the props claim image payloads", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.useFakeTimers();
        document.body.innerHTML = "";
        editor = await makeCorpusEditor("start\n", [imagePastePlugin]);
        v = editor.action((ctx) => ctx.get(editorViewCtx));
    });

    afterEach(async () => { vi.useRealTimers(); await editor.destroy(); });

    const paste = (dt: DataTransfer) =>
        v.someProp("handlePaste", (f) => f(v, { clipboardData: dt } as ClipboardEvent, undefined as never)) ?? false;

    // The fix: claiming the paste is what stops PM inserting the HTML <img>.
    it("an image paste should be claimed so PM never pastes the HTML flavor", () => {
        expect(paste(transfer({ file: png(), html: "<img src='https://x/a.png' alt='alt'>" }))).toBe(true);
    });

    it("claiming the paste should insert nothing synchronously", () => {
        const before = editor.action(getMarkdown());
        paste(transfer({ file: png(), html: "<img src='https://x/a.png' alt='alt'>" }));
        // The save is a round trip; the document only changes when it resolves,
        // and crucially the HTML <img> is never inserted as a second image.
        expect(editor.action(getMarkdown())).toBe(before);
    });

    it("a paste with no image should be passed through untouched", () => {
        expect(paste(transfer({ html: "<p>hi</p>", text: "hi" }))).toBe(false);
    });

    it("a drop with no image should be passed through untouched", () => {
        const handled = v.someProp("handleDrop", (f) =>
            f(v, { dataTransfer: transfer({ text: "hi" }), clientX: 0, clientY: 0 } as unknown as DragEvent,
                undefined as never, false)) ?? false;
        expect(handled).toBe(false);
    });
});
