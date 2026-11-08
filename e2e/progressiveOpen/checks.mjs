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

    // ── A reveal into the streamed tail ──
    // A line the first chunk does not hold: `init` asks for it before the
    // model has it, so the caret and the scroll have to land once the block
    // arrives rather than on whatever the first screen ends with. Section N's
    // heading is document line 8N - 3 in this fixture.
    const tailLine = 8 * 2500 - 3;
    await page.goto(`${baseUrl}/index.html?at=${tailLine}`);
    await marked(page, "editor-painted");
    const stillStreaming = await page.evaluate(() => performance.getEntriesByName("mdw:stream-end", "mark").length === 0);
    check("the reveal is asked for while the target is not yet in the model", stillStreaming === true);
    await marked(page, "stream-end");
    await page.waitForFunction(() => {
        const sel = window.getSelection();
        const block = sel?.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest(".ProseMirror > *");
        return block?.tagName === "H2" && block.textContent.endsWith("Section 2500");
    }, null, { timeout: 10000 }).catch(() => {});
    const landed = await page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const block = el?.closest(".ProseMirror > *");
        const rect = block?.getBoundingClientRect();
        return { tag: block?.tagName ?? null, text: block?.textContent ?? null, top: rect?.top ?? null, height: window.innerHeight };
    });
    check("the caret lands in the streamed heading it was asked for", landed.tag === "H2" && landed.text?.endsWith("Section 2500"), JSON.stringify(landed));
    check("and that heading is on screen", landed.top !== null && landed.top >= 0 && landed.top < landed.height, JSON.stringify(landed));

    // The same reveal as a `scrollToLine` message to a page already up (a
    // search hit, a backlink, `bwr --at` on a file already open), posted
    // while the stream still runs.
    const blockAtCaret = () => page.evaluate(() => {
        const node = window.getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const block = el?.closest(".ProseMirror > *");
        return block ? { tag: block.tagName, text: block.textContent } : null;
    });
    const msgLine = 8 * 2400 - 3;
    await page.goto(`${baseUrl}/index.html`);
    await marked(page, "editor-painted");
    check("the message is posted while the stream runs", await page.evaluate(() => performance.getEntriesByName("mdw:stream-end", "mark").length === 0));
    await page.evaluate((line) => window.postMessage({ type: "scrollToLine", line }, "*"), msgLine);
    await marked(page, "stream-end");
    await page.waitForFunction(() => {
        const node = window.getSelection()?.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        return el?.closest(".ProseMirror > *")?.textContent.endsWith("Section 2400");
    }, null, { timeout: 10000 }).catch(() => {});
    const byMessage = await blockAtCaret();
    check("a scrollToLine message into the tail lands once the tail arrives", byMessage?.tag === "H2" && byMessage.text.endsWith("Section 2400"), JSON.stringify(byMessage));

    // A small document is whole at once, so its reveal is not held at all.
    const smallLine = 8 * 5 - 3;
    await page.goto(`${baseUrl}/index.html?small=1&at=${smallLine}`);
    await marked(page, "editor-painted");
    const small5 = await blockAtCaret();
    check("a reveal in a small document lands by the first paint", small5?.tag === "H2" && small5.text.endsWith("Section 5"), JSON.stringify(small5));

    // ── Below the floor: a whole open ──
    await page.goto(`${baseUrl}/index.html?small=1`);
    await marked(page, "editor-painted");
    await marked(page, "stream-end");
    const small = await page.evaluate(() => ({ chars: window.__docLength, at: window.__at }));
    check("the small fixture is below the floor", small.chars < 150000, `chars=${small.chars}`);
    check("and opens whole, every block on screen at the paint",
        small.at["mdw:editor-painted"].blocks === small.at["mdw:stream-end"].blocks, JSON.stringify(small.at));
}
