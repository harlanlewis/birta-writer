/**
 * MAR-429 — the progressive open, in a real browser.
 *
 * jsdom proves the streamed document is the one a whole open gives and that
 * nothing serializes a partial one; it cannot see that the editor is on
 * screen and taking keys while the rest of the document is still arriving,
 * or that a save asked for meanwhile answers with the file's own bytes. What
 * must hold, in Chromium and in WebKit:
 *
 *   - `editor-painted` lands with a fraction of the document's blocks, and
 *     `stream-end` lands later with all of them;
 *   - a `flushSave` posted while the stream runs answers with the original
 *     text, whole, and never a serialization of the partial document;
 *   - a keystroke during the stream keeps its place, and the update posted
 *     once the stream completes carries it in the whole document, with the
 *     file's own four-space spelling intact;
 *   - a document below the floor opens whole, with no stream to speak of.
 */

const marked = (page, name) =>
    page.waitForFunction(
        (n) => performance.getEntriesByName("mdw:" + n, "mark").length > 0,
        name,
        { timeout: 30000 },
    );

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await marked(page, "editor-painted");

    const docLength = await page.evaluate(() => window.__docLength);
    check("the fixture is past the floor", docLength > 150000, `chars=${docLength}`);

    // Asked while the stream is still running: the answer is the file's bytes.
    const streaming = await page.evaluate(() => performance.getEntriesByName("mdw:stream-end", "mark").length === 0);
    check("the stream is still running at editor-painted", streaming === true);
    await page.evaluate(() => { window.postMessage({ type: "flushSave", id: "during" }, "*"); });
    await page.waitForFunction(() => window.__posted.some((m) => m.type === "flushResult" && m.id === "during"), null, { timeout: 10000 });
    const during = await page.evaluate(() => window.__posted.find((m) => m.type === "flushResult" && m.id === "during").content);
    const original = await page.evaluate(() => window.__doc);
    check("a save during the stream answers with the whole original text", during === original,
        `got ${during.length} chars, expected ${original.length}`);

    // A keystroke during the stream, into the opening paragraph.
    await page.click(".milkdown .ProseMirror p");
    await page.keyboard.press("End");
    await page.keyboard.type("Q");

    await marked(page, "stream-end");
    const at = await page.evaluate(() => window.__at);
    const painted = at["mdw:editor-painted"];
    const done = at["mdw:stream-end"];
    check("the editor painted with a fraction of the document", painted.blocks > 0 && painted.blocks * 4 < done.blocks,
        `painted with ${painted.blocks} blocks, complete at ${done.blocks}`);
    check("and the stream completed after the paint", done.t > painted.t, JSON.stringify({ painted: painted.t, done: done.t }));

    await page.waitForFunction(
        () => window.__posted.some((m) => m.type === "update" && typeof m.content === "string" && m.content.includes("Opening paragraph.Q")),
        null,
        { timeout: 20000 },
    );
    const update = await page.evaluate(() => window.__posted.find((m) => m.type === "update" && m.content.includes("Opening paragraph.Q")).content);
    check("the update after the stream carries the keystroke where it was typed", update.startsWith("# Progressive document\n\nOpening paragraph.Q\n"), JSON.stringify(update.slice(0, 80)));
    check("and the whole document, in the file's own four-space spelling",
        update.length === original.length + 1 && update.includes("\n    - nested under one of 2600\n"), `length ${update.length} vs ${original.length}`);

    const caretBlock = await page.evaluate(() => {
        const sel = document.getSelection();
        return sel?.anchorNode?.parentElement?.closest(".ProseMirror > *")?.textContent ?? null;
    });
    check("the caret is still in the paragraph it was typing in", caretBlock !== null && caretBlock.startsWith("Opening paragraph.Q"), JSON.stringify(caretBlock));

    // ── Below the floor: a whole open ──
    await page.goto(`${baseUrl}/index.html?small=1`);
    await marked(page, "editor-painted");
    await marked(page, "stream-end");
    const small = await page.evaluate(() => ({ chars: window.__docLength, at: window.__at }));
    check("the small fixture is below the floor", small.chars < 150000, `chars=${small.chars}`);
    check("and opens whole, every block on screen at the paint",
        small.at["mdw:editor-painted"].blocks === small.at["mdw:stream-end"].blocks, JSON.stringify(small.at));
}
