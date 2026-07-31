/**
 * plugins/imagePaste.ts — pasting or dropping an image FILE (MAR-277).
 *
 * Copying an image from a browser puts two things on the clipboard: an HTML
 * flavor (`<img src="https://…" alt="…">`) and the image file itself. The
 * editor wanted the file — it saves the bytes next to the document — but the
 * detection lived in a `document`-level listener, and ProseMirror's own paste
 * handler is bound to the editor element *inside* it. Bubble order therefore
 * guaranteed PM went first: it pasted the HTML `<img>` (alt intact, pointing at
 * a remote URL the webview's CSP won't load, so it rendered as "Image not
 * found"), and only then did the document listener save the file and insert a
 * SECOND image — with the path but no alt. One paste, two broken halves.
 *
 * Registering as a ProseMirror prop puts the decision inside PM's own paste
 * handling, before it ever looks at the clipboard's HTML, so there is exactly
 * one insert. The alt text is lifted off the discarded HTML flavor, so an image
 * copied from a page keeps the description it had there — the one genuinely
 * useful thing that path was carrying.
 *
 * A DROP also has an aim, which PM has no hook for: editing/fileDrop.ts tracks
 * the drag and draws the accent drop line at the block boundary nearest the
 * pointer, and `handleDrop` lands the image on that line. Without it the only
 * available answer is `posAtCoords`, an INLINE position — so an image dropped
 * onto a paragraph landed inside the sentence under the pointer rather than as
 * a block of its own.
 *
 * A payload can also carry MORE THAN ONE image — three files selected in
 * Finder and dragged in together is an ordinary gesture — so detection is
 * plural (MAR-281) and the whole batch lands as one edit; see
 * `saveAndInsertImagesAt`.
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@/pm";
import type { EditorView } from "@/pm";
import { saveAndInsertImagesAt } from "../imageUpload";
import { aimedDropPos, clearDropAim } from "../editing/fileDrop";

/**
 * Every image file on a clipboard/drag payload, in payload order (MAR-281).
 *
 * Plural because a drag routinely is: selecting three files in Finder and
 * dragging them in is one gesture carrying three images, and the singular
 * predecessor of this function read only the first — the other two were
 * discarded with no message, so the drop looked like it had succeeded.
 */
export function imageFilesFrom(data: DataTransfer | null | undefined): File[] {
    if (!data) { return []; }
    // `items` carries a pasted screenshot (which has no entry in `files` on
    // some platforms); `files` carries dragged-in files. The two OVERLAP, so
    // `files` is a fallback for when `items` yielded nothing — never an
    // addition to it, which would insert every dragged file twice.
    const fromItems = Array.from(data.items ?? [])
        .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
    if (fromItems.length > 0) { return fromItems; }
    return Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * The alt text of the first `<img>` in a clipboard's HTML flavor. Parsed with
 * DOMParser into an inert document — the markup is never inserted anywhere, and
 * this reads one attribute off it.
 */
export function altFromHtmlFlavor(html: string | null | undefined): string {
    if (!html) { return ""; }
    try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        return doc.querySelector("img")?.getAttribute("alt") ?? "";
    } catch {
        return "";
    }
}

export const imagePastePlugin = $prose(() =>
    new Plugin({
        props: {
            handlePaste(view: EditorView, event: ClipboardEvent) {
                // Usually one file — a browser image copy, a screenshot. But
                // copying several files in a file manager and pasting is the
                // same multi-file payload a drag carries, so it takes the same
                // plural path rather than silently keeping the first.
                const files = imageFilesFrom(event.clipboardData);
                if (files.length === 0) { return false; }
                const alt = altFromHtmlFlavor(event.clipboardData?.getData("text/html"));
                saveAndInsertImagesAt(view, files, alt, view.state.selection.from);
                return true; // handled: PM must not also paste the HTML flavor
            },
            handleDrop(view: EditorView, event: DragEvent) {
                const files = imageFilesFrom(event.dataTransfer);
                if (files.length === 0) { return false; }
                const alt = altFromHtmlFlavor(event.dataTransfer?.getData("text/html"));
                // Land on the line the drag was showing. It falls back to the
                // inline position under the pointer when there is no aim — a
                // drop with no preceding dragover, or one released over chrome.
                const aimed = aimedDropPos();
                const at = aimed
                    ?? view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
                    ?? view.state.selection.from;
                clearDropAim();
                saveAndInsertImagesAt(view, files, alt, at);
                return true;
            },
        },
    }));
