/**
 * Unsafe link addresses render inert, and the file keeps its bytes.
 *
 * Milkdown 7.22.0 runs the link mark's `href` through `sanitizeLinkHref` in
 * `toDOM` (#2410). Before it, `[click](javascript:alert(1))` in a document
 * someone else wrote became a real, clickable anchor that ran their script.
 *
 * Two halves, and the second is the one a dependency bump can silently take
 * away in the other direction:
 *
 *   1. The RENDERING is inert — no `javascript:` or `data:` href reaches the
 *      DOM. This is upstream's behavior; the test exists because we now depend
 *      on it and a future bump could drop it.
 *   2. The DOCUMENT is untouched — the address still round-trips to disk
 *      verbatim, and the link popup still reports the real address rather than
 *      the sanitized rendering. Sanitizing a rendering must never become
 *      rewriting a file. That second part is not upstream's doing at all: the
 *      popup used to read `anchor.getAttribute("href")`, which after #2410
 *      returns "" for exactly these links, so opening the popup and applying
 *      an edit would have written the emptiness over the user's address.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { findLinkAt } from "../components/linkPopup";

/** Addresses a browser will execute, and the shapes people try to sneak them in as. */
const UNSAFE = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>x</script>",
];

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

afterEach(async () => {
    for (const editor of editors) { await editor.destroy(); }
    editors = [];
    document.body.innerHTML = "";
});

describe("link href safety", () => {
    for (const href of UNSAFE) {
        it(`${href} should not reach the DOM as a live href`, async () => {
            const editor = await makeEditor(`[click](${href})\n`);
            const anchor = (view(editor).dom as HTMLElement).querySelector("a");
            expect(anchor, "the link should still render as an anchor").not.toBeNull();
            expect(anchor!.textContent).toBe("click");
            const rendered = (anchor!.getAttribute("href") ?? "").toLowerCase();
            expect(rendered.startsWith("javascript:")).toBe(false);
            expect(rendered.startsWith("data:")).toBe(false);
        });

        it(`${href} should still round-trip to the file verbatim`, async () => {
            // Sanitizing a rendering must not rewrite the document. Compare the
            // parsed address, not the serialized line: remark escapes `(` in a
            // destination, which is a spelling change the parser undoes.
            const editor = await makeEditor(`[click](${href})\n`);
            const reopened = await makeEditor(editor.action(getMarkdown()));
            const link = findLinkAt(
                view(reopened),
                (view(reopened).dom as HTMLElement).querySelector("a")!,
            );
            expect(link?.href).toBe(href);
        });

        it(`the link popup should report ${href}, not the sanitized rendering`, async () => {
            // The popup fills its URL field from this; reading the DOM here
            // would show "" and applying would erase the address.
            const editor = await makeEditor(`[click](${href})\n`);
            const anchor = (view(editor).dom as HTMLElement).querySelector("a")!;
            expect(findLinkAt(view(editor), anchor)?.href).toBe(href);
        });
    }

    it("an ordinary link should be untouched in both directions", async () => {
        // Guards the inverse failure: a sanitizer that ate everything would
        // pass every assertion above.
        const editor = await makeEditor("[ok](https://example.com)\n");
        const anchor = (view(editor).dom as HTMLElement).querySelector("a")!;
        expect(anchor.getAttribute("href")).toBe("https://example.com");
        expect(findLinkAt(view(editor), anchor)?.href).toBe("https://example.com");
        expect(editor.action(getMarkdown())).toBe("[ok](https://example.com)\n");
    });
});
