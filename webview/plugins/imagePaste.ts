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
 */
import { $prose } from "@milkdown/utils";
import { Plugin } from "@/pm";
import type { EditorView } from "@/pm";
import { saveAndInsertImageAt } from "../imageUpload";

/** The first image file on a clipboard/drag payload, or null. */
export function imageFileFrom(data: DataTransfer | null | undefined): File | null {
    if (!data) { return null; }
    // `items` carries a pasted screenshot (which has no entry in `files` on
    // some platforms); `files` carries a dragged-in file. Check both.
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) { return file; }
        }
    }
    return Array.from(data.files ?? []).find((f) => f.type.startsWith("image/")) ?? null;
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
                const file = imageFileFrom(event.clipboardData);
                if (!file) { return false; }
                const alt = altFromHtmlFlavor(event.clipboardData?.getData("text/html"));
                saveAndInsertImageAt(view, file, alt, view.state.selection.from);
                return true; // handled: PM must not also paste the HTML flavor
            },
            handleDrop(view: EditorView, event: DragEvent) {
                const file = imageFileFrom(event.dataTransfer);
                if (!file) { return false; }
                const alt = altFromHtmlFlavor(event.dataTransfer?.getData("text/html"));
                // Drop where the pointer is, not where the caret happens to be.
                const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
                saveAndInsertImageAt(view, file, alt, at?.pos ?? view.state.selection.from);
                return true;
            },
        },
    }));
