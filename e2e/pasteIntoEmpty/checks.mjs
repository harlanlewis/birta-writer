/**
 * Pasting an image into an EMPTY document must put its reference in the
 * document, not only save the file.
 *
 * This is Birta Writer for Mac's opening gesture: summon the scratchpad, paste a
 * screenshot. Found by driving the real panel, where the bytes reached disk and
 * the document stayed empty, so the user saw nothing happen and the file was
 * there all along.
 *
 * Three arms isolate which condition owns it, because "empty document" and
 * "the caret was never placed by hand" were both true in the case that failed:
 *   - empty, caret placed by a click
 *   - empty, no click at all (the editor is focused, nothing was clicked)
 *   - non-empty, caret placed by a click (the control that worked)
 */
export async function run({ page, check, baseUrl }) {
    /** Mount with `content`, optionally clicking into the editor first. */
    async function mount(content, { click }) {
        const url = `${baseUrl}/index.html?content=${encodeURIComponent(content)}`;
        await page.goto(url);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForTimeout(400);
        if (click) {
            await page.locator(".milkdown .ProseMirror").click();
            await page.waitForTimeout(150);
        }
    }

    /** Dispatch a real paste carrying one PNG file, as a screenshot paste does. */
    async function pasteImage() {
        await page.evaluate(() => {
            // A 1x1 PNG, the same bytes the app-level probe uses.
            const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
            const file = new File([bytes], "shot.png", { type: "image/png" });
            const dt = new DataTransfer();
            dt.items.add(file);
            const target = document.querySelector(".milkdown .ProseMirror");
            target.dispatchEvent(new ClipboardEvent("paste", {
                clipboardData: dt, bubbles: true, cancelable: true,
            }));
        });
        await page.waitForTimeout(900);
    }

    /** The most recent serialized document the webview posted out. */
    const latest = () => page.evaluate(() => {
        const ups = window.__posted.filter((m) => m.type === "update");
        return ups.length ? ups[ups.length - 1].content : "";
    });
    const uploads = () => page.evaluate(
        () => window.__posted.filter((m) => m.type === "uploadImage").length);

    // ── Empty document, caret placed by a click ────────────────────────
    await mount("", { click: true });
    await pasteImage();
    check("empty + click: the host was asked to save the image", await uploads() === 1);
    const emptyClicked = await latest();
    check("empty + click: the reference is in the document",
        /!\[\]\(Attachments\/abc123\.png\)/.test(emptyClicked), JSON.stringify(emptyClicked));

    // ── Empty document, nothing clicked ────────────────────────────────
    // The panel focuses the editor on summon, so this is what a paste
    // immediately after the hotkey looks like.
    await mount("", { click: false });
    await page.evaluate(() => document.querySelector(".milkdown .ProseMirror").focus());
    await pasteImage();
    check("empty + no click: the host was asked to save the image", await uploads() === 1);
    const emptyUnclicked = await latest();
    check("empty + no click: the reference is in the document",
        /!\[\]\(Attachments\/abc123\.png\)/.test(emptyUnclicked), JSON.stringify(emptyUnclicked));

    // ── Non-empty document: the arm that already worked ────────────────
    await mount("hi\n", { click: true });
    await page.keyboard.press("End");
    await pasteImage();
    const nonEmpty = await latest();
    check("non-empty: the reference is in the document",
        /!\[\]\(Attachments\/abc123\.png\)/.test(nonEmpty), JSON.stringify(nonEmpty));
    check("non-empty: the text that was already there survives",
        /hi/.test(nonEmpty), JSON.stringify(nonEmpty));
}
