/**
 * Image-paste end-to-end checks against the real bundle (MAR-277).
 *
 * This suite exists because the unit tests STRUCTURALLY could not catch the bug
 * it guards. Copying an image from a browser puts both an HTML `<img>` and the
 * file on the clipboard; image detection lived in a `document`-level listener,
 * and ProseMirror's paste handler is bound to the editor element inside it, so
 * bubble order guaranteed PM went first — pasting the HTML `<img>` and leaving
 * the saved file to insert a second image. The unit tests invoked the prop
 * DIRECTLY (`someProp("handlePaste", …)`), which bypasses the very event
 * dispatch the bug lived in: a green prop-level test and a broken editor were
 * entirely compatible.
 *
 * So these dispatch a real ClipboardEvent carrying both flavors, exactly as the
 * browser does, and count what lands in the document.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    /** The most recent serialized document the webview posted out. */
    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    /** Everything the webview asked the extension to save. */
    const uploadRequests = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "uploadImage").length);

    await page.evaluate(() => {
        const p = document.querySelector(".milkdown .ProseMirror p");
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        p.closest(".ProseMirror").focus();
    });

    // A real clipboard from a browser image copy: an HTML <img> flavor AND the
    // file itself. Both must reach the editor; only ONE image may result.
    await page.evaluate(() => {
        const el = document.querySelector(".milkdown .ProseMirror");
        const dt = new DataTransfer();
        dt.setData("text/html", "<img src='https://example.com/remote.png' alt='A person at a laptop'>");
        const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        dt.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
        const ev = new ClipboardEvent("paste", {
            clipboardData: dt, bubbles: true, cancelable: true,
        });
        el.dispatchEvent(ev);
        window.__imagePasteClaimed = ev.defaultPrevented;
    });
    await page.waitForTimeout(500);
    const claimed = await page.evaluate(() => window.__imagePasteClaimed);

    // The webview asks the extension to save the FILE — exactly once.
    check("the pasted file is sent for saving once", (await uploadRequests()) === 1,
        `uploadImage messages: ${await uploadRequests()}`);

    // The decisive assertion: the clipboard's HTML <img> must NOT have been
    // pasted as a second image. The save never resolves in this harness (no
    // extension host answers), so a correct editor shows ZERO images — the bug
    // showed one, from the HTML flavor.
    // `:not(.ProseMirror-separator)` matters: ProseMirror renders its own
    // `<img class="ProseMirror-separator">` artifacts into contenteditable, so a
    // bare `img` selector reports one even for a document with no images.
    const imgs = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".ProseMirror img:not(.ProseMirror-separator)"))
            .map((i) => `${i.getAttribute("src")}|${i.getAttribute("alt")}`));
    check("the clipboard's HTML <img> is not pasted alongside the file", imgs.length === 0,
        JSON.stringify(imgs));

    // The paste is claimed before ProseMirror reaches the HTML flavor.
    check("the paste event is claimed (default prevented)", claimed === true, String(claimed));

    // The alt is the one useful thing the discarded HTML flavor carried, so it
    // rides along to the saved image rather than being thrown away with it.
    const savedAlt = await page.evaluate(() =>
        window.__posted.find((m) => m.type === "uploadImage")?.altText);
    check("the alt is lifted off the discarded HTML flavor",
        savedAlt === "A person at a laptop", JSON.stringify(savedAlt));

    const md = await latest();
    check("no stray image markup reached the document",
        md === null || !md.includes("remote.png"), JSON.stringify(md));

    // A paste with no image at all must still behave normally.
    await page.evaluate(() => {
        const el = document.querySelector(".milkdown .ProseMirror");
        const dt = new DataTransfer();
        dt.setData("text/plain", "just words");
        el.dispatchEvent(new ClipboardEvent("paste", {
            clipboardData: dt, bubbles: true, cancelable: true,
        }));
    });
    await page.waitForTimeout(400);
    const after = await latest();
    check("a non-image paste still inserts its text",
        after?.includes("just words"), JSON.stringify(after));
    check("a non-image paste sends no save request", (await uploadRequests()) === 1,
        `uploadImage messages: ${await uploadRequests()}`);
}
