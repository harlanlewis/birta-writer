/**
 * MAR-428 — the static first frame, in a real browser.
 *
 * jsdom can decide which documents get a frame and what it renders; it cannot
 * see that the frame is PAINTED before the model build starts, that the live
 * editor replaces it with no gap, or that keys pressed in between reach the
 * document. What must hold:
 *
 *   - on a large document, at the `frame-painted` mark there is a read-only
 *     render of the first screen, its capture field holds focus, and no live
 *     editor exists yet;
 *   - text typed while the frame is up lands at the caret's opening position
 *     in the live editor, in order, and the frame is gone at `editor-painted`;
 *   - a document below the size floor never gets a frame, and stamps no
 *     frame mark at all.
 */

const marked = (page, name) =>
    page.waitForFunction(
        (n) => performance.getEntriesByName("mdw:" + n, "mark").length > 0,
        name,
        { timeout: 20000 },
    );

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await marked(page, "frame-painted");
    // Typed while the model builds: this is the window the frame exists for.
    await page.keyboard.type("abc");
    await marked(page, "editor-painted");
    await page.waitForSelector(".milkdown:not(.birta-first-frame) .ProseMirror", { timeout: 15000 });

    const docLength = await page.evaluate(() => window.__docLength);
    check("the fixture is past the frame's size floor", docLength > 150000, `chars=${docLength}`);

    const at = await page.evaluate(() => window.__at);
    const atFrame = at["mdw:frame-painted"];
    check("at frame-painted a read-only render of the first screen is on screen",
        atFrame?.frameHeadings > 0 && atFrame?.frameEditable === "false", JSON.stringify(atFrame));
    check("at frame-painted the capture field holds focus", atFrame?.sinkFocused === true, JSON.stringify(atFrame));
    check("at frame-painted no live editor exists yet", atFrame?.liveEditor === false, JSON.stringify(atFrame));

    const atPaint = at["mdw:editor-painted"];
    check("at editor-painted the frame is gone", atPaint?.frameCount === 0, JSON.stringify(atPaint));
    check("at editor-painted the live editor is on screen", atPaint?.liveEditor === true, JSON.stringify(atPaint));

    const firstBlock = await page.$eval(
        ".milkdown:not(.birta-first-frame) .ProseMirror > :first-child",
        (el) => el.textContent,
    );
    // `textContent` carries the heading's level chrome ahead of its text, so
    // the assertion is on the text's own start.
    check("text typed during the window landed at the caret's opening position",
        firstBlock.includes("abcFirst frame document"), `first block: ${JSON.stringify(firstBlock)}`);

    const frameSpan = await page.evaluate(() => {
        const m = performance.getEntriesByName("mdw:frame", "measure");
        return m.length ? Math.round(m[0].duration) : null;
    });
    check("the frame span is stamped for the harness to report", frameSpan !== null, `frame=${frameSpan}ms`);

    const focused = await page.evaluate(() => document.activeElement?.closest(".ProseMirror") !== null);
    check("the live editor holds focus after the swap", focused === true);

    // The replayed text must reach the save pipeline like typed text: an
    // `update` carrying it is posted once the sync scheduler's idle window
    // passes. Without the interaction flag lifted, nothing is ever posted.
    const synced = await page
        .waitForFunction(
            () => window.__posted.some((m) => m.type === "update" && typeof m.content === "string" && m.content.startsWith("# abcFirst frame document")),
            null,
            { timeout: 5000 },
        )
        .then(() => true, () => false);
    check("the text typed during the window reached the document sync", synced === true);

    // Keys queued behind the model build target whatever is focused when they
    // dispatch: the live editor, not the body the removed field left.
    await page.keyboard.type("d");
    const afterKey = await page.$eval(
        ".milkdown:not(.birta-first-frame) .ProseMirror > :first-child",
        (el) => el.textContent,
    );
    check("a key pressed after the swap lands after the replayed text", afterKey.includes("abcdFirst frame document"), JSON.stringify(afterKey));

    // ── A small document: no frame, no frame mark ──
    await page.goto(`${baseUrl}/index.html?small=1`);
    await marked(page, "editor-painted");
    await page.waitForTimeout(300);
    const smallMarks = await page.evaluate(() => ({
        frame: performance.getEntriesByName("mdw:frame-painted", "mark").length,
        frames: document.querySelectorAll(".birta-first-frame").length,
        chars: window.__docLength,
    }));
    check("a document under the size floor is small", smallMarks.chars < 150000, `chars=${smallMarks.chars}`);
    check("and gets no frame and stamps no frame mark", smallMarks.frame === 0 && smallMarks.frames === 0, JSON.stringify(smallMarks));
}
