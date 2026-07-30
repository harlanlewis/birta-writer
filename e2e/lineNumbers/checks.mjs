/**
 * The source line-number gutter, in a real browser.
 *
 * Nothing important about this feature is observable in jsdom. A source line has
 * no fixed height once rendered — a heading, a table row, a code line and a
 * paragraph that wraps to twelve visual rows all occupy exactly one source line
 * — so "is each number where its content is" is a question only a layout engine
 * can answer. The unit tests cover the index (`sourceLineIndex.test.ts`) and the
 * placement arithmetic (`lineNumberLayout.test.ts`); everything below is the part
 * they structurally cannot reach.
 *
 * What must hold:
 *
 *   - numbers are ordered and never overlap, whatever the content does;
 *   - a number sits at the top of the content it labels (measured against the
 *     rendered element, not assumed);
 *   - a source line that renders TALL gets the room it takes — the long
 *     paragraph's number is followed by a gap of many line-heights;
 *   - a code block's interior is left to the code block's own gutter, but both
 *     fence lines are numbered;
 *   - the layer is layout-neutral and non-interactive, so it can never move
 *     content or steal the marquee gesture from the start margin;
 *   - scrolling does not move a number relative to its content (the layer is in
 *     document coordinates — that is what makes scrolling free);
 *   - folding a section takes its numbers with it;
 *   - nothing exists at the first-paint mark;
 *   - and with the setting OFF, the browser never even fetches the chunk.
 */

const SETTLE = 300;

/** Wait for the rAF-coalesced measure/paint pass to land. */
async function settle(page) {
    await page.waitForTimeout(SETTLE);
    await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.waitForTimeout(SETTLE);
}

/** Every painted number as `{ line, top }`, in document coordinates, sorted. */
const painted = (page) =>
    page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll(".line-number")) {
            if (el.hidden) { continue; }
            out.push({ line: Number(el.textContent), top: Number.parseFloat(el.style.top) });
        }
        return out.sort((a, b) => a.top - b.top);
    });

/**
 * The document-coordinate centre of the first TEXT ROW of the block containing
 * `text`, plus the block's own border-box top.
 *
 * Deliberately the text's inline box, not the element box: a heading's
 * `--content-heading-before` is padding, so an h1's border box begins ~30 px
 * above its glyphs. Asserting against the element box would happily pass a
 * number sitting in the blank space above a heading — which is where they used
 * to sit, and which reads as belonging to the previous line. `boxTop` is
 * returned alongside so that failure is legible rather than just a number.
 *
 * Matched with `includes`, because a heading's `textContent` also carries its
 * gutter widget's label — an exact comparison finds nothing at all for exactly
 * the blocks worth checking.
 */
const contentRow = (page, text) =>
    page.evaluate((needle) => {
        for (const el of document.querySelectorAll(".milkdown .ProseMirror > *")) {
            if (!el.textContent.includes(needle)) { continue; }
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let node = walker.nextNode();
            // Skip the gutter widget's own label to reach the content's text.
            while (node && !needle.startsWith(node.textContent.trim().slice(0, 4))) {
                node = walker.nextNode();
            }
            if (!node) { return null; }
            const range = document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, Math.min(3, node.textContent.length));
            const rect = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return {
                centre: rect.top + rect.height / 2 + window.scrollY,
                boxTop: box.top + window.scrollY,
                boxBottom: box.bottom + window.scrollY,
            };
        }
        return null;
    }, text);

export async function run({ page, check, baseUrl }) {
    // ── The setting OFF: the feature costs nothing ──────────────────────────
    await page.goto(`${baseUrl}/off.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout
        ? await page.waitForTimeout(1200) // the post-paint idle window, then some
        : null;

    const off = await page.evaluate(() => ({
        layers: document.querySelectorAll(".line-number-layer").length,
        numbers: document.querySelectorAll(".line-number").length,
        styles: document.querySelectorAll("#line-number-styles").length,
        // The proof the module was never even fetched: no resource entry for it.
        chunk: performance
            .getEntriesByType("resource")
            .filter((e) => /lineNumbers-.*\.js$/.test(e.name)).length,
    }));
    check(
        "with the setting off, no gutter exists in the DOM",
        off.layers === 0 && off.numbers === 0 && off.styles === 0,
        JSON.stringify(off),
    );
    check(
        "with the setting off, the gutter's chunk is never fetched",
        off.chunk === 0,
        `resource entries for the lineNumbers chunk: ${off.chunk}`,
    );

    // ── The setting ON ──────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForSelector(".line-number", { timeout: 15000 });
    await settle(page);

    const at = await page.evaluate(() => window.__at);

    // ── 1. Nothing on the mount path ───────────────────────────────────────
    const atPaint = await page.evaluate(() => window.__atPaint);
    check(
        "no line numbers are painted before the first-paint mark",
        !!atPaint && atPaint.numbers === 0,
        JSON.stringify(atPaint),
    );

    // ── 2. Ordered, and never overlapping ──────────────────────────────────
    const rows = await painted(page);
    check("the gutter paints a useful number of lines", rows.length > 15, `painted=${rows.length}`);

    const disordered = rows.filter((r, i) => i > 0 && r.line <= rows[i - 1].line);
    check(
        "numbers ordered by position are also ordered by line",
        disordered.length === 0,
        `out of order: ${disordered.slice(0, 5).map((r) => r.line).join(", ")}`,
    );

    // The minimum gap is the gutter's own line-height; measure it rather than
    // hard-coding, so a font-size change to the chrome scale cannot make this
    // assertion silently wrong.
    const gutterLineHeight = await page.evaluate(() => {
        const el = document.querySelector(".line-number");
        return Number.parseFloat(getComputedStyle(el).lineHeight) || 14;
    });
    const overlaps = rows.filter((r, i) => i > 0 && r.top - rows[i - 1].top < gutterLineHeight - 0.5);
    check(
        "no two numbers overlap",
        overlaps.length === 0,
        `minGap=${gutterLineHeight.toFixed(1)} overlapping: ${overlaps.slice(0, 5).map((r) => r.line).join(", ")}`,
    );

    // ── 3. A number sits at the top of the content it labels ───────────────
    // Only blocks near the top: the gutter is WINDOWED (two screens each side),
    // so the end of the document is legitimately unnumbered from here. That the
    // window follows the reader is asserted separately, after a scroll.
    // A heading is the case worth being strict about: its own padding puts its
    // border box a whole row above its glyphs, so "beside the text" and "at the
    // top of the block" are different places, and only the first is useful.
    for (const [name, text] of [
        ["title", "Line number zoo"],           // h1 — ~30px of padding above
        ["intro", "An opening paragraph on a single source line."],
        ["tightHead", "Tight list"],            // h2 — ~19px
        ["tight", "alpha"],
    ]) {
        const line = at[name];
        const number = rows.find((r) => r.line === line);
        const row = await contentRow(page, text);
        const numberCentre = number ? number.top + gutterLineHeight / 2 : NaN;
        check(
            `line ${line} (${name}) is numbered beside its text, not above its block`,
            !!number && !!row && Math.abs(numberCentre - row.centre) <= 3,
            row
                ? `number centre=${numberCentre.toFixed(1)} text centre=${row.centre.toFixed(1)} (block box top=${row.boxTop.toFixed(1)})`
                : "content row not found",
        );
    }

    // ── 4. A tall source line gets the room it takes ───────────────────────
    // The long paragraph is ONE source line wrapping to many visual rows: its
    // number must be followed by a gap far larger than a line. This is the case
    // an evenly-spaced ladder gets wrong, and it is why the gutter measures.
    const longIndex = rows.findIndex((r) => r.line === at.longPara);
    const longGap = longIndex >= 0 && rows[longIndex + 1]
        ? rows[longIndex + 1].top - rows[longIndex].top
        : 0;
    check(
        "a source line that wraps to many rows is followed by a proportionate gap",
        longGap > gutterLineHeight * 4,
        `gap after line ${at.longPara} = ${longGap.toFixed(1)}px (minGap ${gutterLineHeight.toFixed(1)})`,
    );

    // ...and the blank line that FOLLOWS a tall block belongs in the whitespace
    // AFTER it. This is the case that reads as the gutter having lost track of
    // the document: interpolating a run from the previous line's TOP put the
    // separator's number a third of the way down the paragraph it follows (and,
    // on a video embed, floating in the middle of the video). Every one of these
    // is a source line whose rendered height is many times a line's.
    for (const [name, text, blankLine] of [
        ["longPara", "A very long paragraph on one single", at.longPara + 1],
        ["title", "Line number zoo", at.title + 1],
        // A block with no text position of its own to measure from — the path
        // an image or a video embed takes. Its closing fence is line
        // codeOpen + 4, so the blank separator is the line after that.
        ["code block", "const alpha = 1;", at.codeOpen + 5],
    ]) {
        const box = await contentRow(page, text);
        const blank = rows.find((r) => r.line === blankLine);
        check(
            `the blank line after ${name} is numbered below that block, not inside it`,
            !!blank && !!box && blank.top >= box.boxBottom - 1,
            box
                ? `line ${blankLine} top=${blank ? blank.top.toFixed(1) : "missing"} block bottom=${box.boxBottom.toFixed(1)}`
                : "block not found",
        );
    }

    // The general form of the same rule, over every separator in the window —
    // and the only coverage of the PACKED branch, which is the common case: two
    // paragraphs are separated by a margin narrower than the gutter's own line,
    // so there is no whitespace to sit in and the number packs against the line
    // it precedes. That is above the previous block's box bottom, so the strict
    // assertion above cannot express it. What must hold either way is that the
    // number reads as belonging to what FOLLOWS it, rather than as a stray
    // number adrift inside what precedes it.
    const source = await page.evaluate(() => window.__lines);
    const isBlank = (line) => (source[line - 1] ?? "").trim() === "";
    const strays = [];
    for (let i = 1; i < rows.length - 1; i++) {
        const [prev, row, next] = [rows[i - 1], rows[i], rows[i + 1]];
        // Lone separators only: inside a RUN of blanks the neighbour above is
        // another guess, and "nearer the one below" stops meaning anything.
        if (!isBlank(row.line) || isBlank(prev.line) || isBlank(next.line)) { continue; }
        if (row.top - prev.top < next.top - row.top) { strays.push(row.line); }
    }
    check(
        "a lone blank separator is numbered nearer the block below it than the one above",
        strays.length === 0,
        `separators nearer the block above: ${strays.slice(0, 8).join(", ")}`,
    );

    // A tight list is the opposite extreme: three consecutive source lines, each
    // one short rendered row. All three must survive.
    const tightLines = [at.tight, at.tight + 1, at.tight + 2];
    check(
        "consecutive short source lines are each numbered",
        tightLines.every((l) => rows.some((r) => r.line === l)),
        `expected ${tightLines.join(", ")}`,
    );

    // ── 5. Code blocks: fences only ─────────────────────────────────────────
    const codeOpen = at.codeOpen;
    const codeClose = codeOpen + 4;             // ```js, 3 lines, ```
    const interior = [codeOpen + 1, codeOpen + 2, codeOpen + 3];
    check(
        "a code block's opening and closing fences are both numbered",
        rows.some((r) => r.line === codeOpen) && rows.some((r) => r.line === codeClose),
        `open=${codeOpen} close=${codeClose} painted=${rows.filter((r) => r.line >= codeOpen && r.line <= codeClose).map((r) => r.line).join(",")}`,
    );
    check(
        "a code block's interior is left to the code block's own gutter",
        interior.every((l) => !rows.some((r) => r.line === l)),
        `interior lines painted: ${interior.filter((l) => rows.some((r) => r.line === l)).join(", ")}`,
    );
    // ...and that gutter is still there doing its job.
    const innerGutters = await page.$$eval(".line-numbers-gutter", (els) => els.length);
    check(
        "the code block still draws its own relative gutter",
        innerGutters >= 1,
        `code-block gutters: ${innerGutters}`,
    );

    // ── 6. The layer is layout-neutral and non-interactive ─────────────────
    const layer = await page.evaluate(() => {
        const el = document.querySelector(".line-number-layer");
        const cs = getComputedStyle(el);
        return {
            height: el.getBoundingClientRect().height,
            position: cs.position,
            pointerEvents: cs.pointerEvents,
            userSelect: cs.userSelect || cs.webkitUserSelect,
            ariaHidden: el.getAttribute("aria-hidden"),
            insideEditor: !!el.closest("#editor"),
        };
    });
    check(
        "the layer cannot affect layout, interaction, or the accessibility tree",
        layer.height === 0
            && layer.position === "absolute"
            && layer.pointerEvents === "none"
            && layer.ariaHidden === "true"
            && !layer.insideEditor,
        JSON.stringify(layer),
    );

    // The start margin must still start a marquee: the gutter sits over it, so
    // a pointerdown there has to reach the editor's own handler, not the layer.
    const hitTest = await page.evaluate(() => {
        const el = document.querySelector(".line-number:not([hidden])");
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            Math.max(rect.top + rect.height / 2, 1),
        );
        return hit ? hit.className.toString() : "none";
    });
    check(
        "a pointer over a number hits through to what is beneath it",
        !/line-number/.test(hitTest),
        `elementFromPoint over a number: ${hitTest}`,
    );

    // ── 7. Scrolling does not move a number relative to its content ────────
    const before = await painted(page);
    const beforeTop = (await contentRow(page, "Final paragraph."))?.centre ?? null;
    await page.evaluate(() => window.scrollTo({ top: 1500, behavior: "instant" }));
    await settle(page);
    const after = await painted(page);
    const afterTop = (await contentRow(page, "Final paragraph."))?.centre ?? null;
    check(
        "content keeps its document position across a scroll",
        beforeTop !== null && afterTop !== null && Math.abs(beforeTop - afterTop) < 1,
        `before=${beforeTop} after=${afterTop}`,
    );
    const shared = after.filter((a) => before.some((b) => b.line === a.line));
    const drifted = shared.filter((a) => {
        const b = before.find((x) => x.line === a.line);
        return Math.abs(a.top - b.top) > 1;
    });
    check(
        "a line's number keeps its document position across a scroll",
        shared.length > 3 && drifted.length === 0,
        `shared=${shared.length} drifted=${drifted.slice(0, 5).map((d) => d.line).join(", ")}`,
    );
    check(
        "scrolling brings numbers to the content that arrives",
        after.some((a) => !before.some((b) => b.line === a.line)),
        `before=${before.length} after=${after.length}`,
    );

    // The window follows the reader: the document's last line, unnumbered from
    // the top, is numbered once it is what you are looking at.
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await settle(page);
    const atEnd = await painted(page);
    const lastRow = await contentRow(page, "Final paragraph.");
    const lastNumber = atEnd.find((r) => r.line === at.last);
    check(
        "the document's last line is numbered once scrolled to",
        !!lastNumber && !!lastRow
            && Math.abs(lastNumber.top + gutterLineHeight / 2 - lastRow.centre) <= 3,
        `line ${at.last}: number=${lastNumber ? lastNumber.top.toFixed(1) : "missing"} text centre=${lastRow ? lastRow.centre.toFixed(1) : "?"}`,
    );

    // ── 8. Folding takes its numbers with it ───────────────────────────────
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await settle(page);
    const foldBodyLine = await page.evaluate(() => window.__at.foldBody);
    const numbered = (rowsNow, line) => rowsNow.some((r) => r.line === line);
    check(
        "the foldable section's body is numbered while expanded",
        numbered(await painted(page), foldBodyLine),
        `line ${foldBodyLine}`,
    );

    const folded = await page.evaluate(() => {
        const headings = [...document.querySelectorAll(".milkdown .ProseMirror h2")];
        const target = headings.find((h) => h.textContent.includes("Foldable section"));
        if (!target) { return false; }
        const toggle = target.querySelector(".heading-fold-toggle")
            ?? target.parentElement?.querySelector(".heading-fold-toggle");
        if (!toggle) { return false; }
        toggle.click();
        return true;
    });
    if (folded) {
        await settle(page);
        const afterFold = await painted(page);
        check(
            "collapsing a section removes its body's numbers",
            !numbered(afterFold, foldBodyLine),
            `line ${foldBodyLine} still painted`,
        );
        check(
            "the collapsed section's own heading keeps its number",
            numbered(afterFold, at.foldHead),
            `heading line ${at.foldHead} missing`,
        );
        const stillOrdered = afterFold.every((r, i) => i === 0 || r.line > afterFold[i - 1].line);
        const stillClear = afterFold.every(
            (r, i) => i === 0 || r.top - afterFold[i - 1].top >= gutterLineHeight - 0.5,
        );
        check(
            "the gutter stays ordered and non-overlapping after a fold",
            stillOrdered && stillClear,
            `ordered=${stillOrdered} clear=${stillClear}`,
        );
    } else {
        check("the fold toggle was reachable", false, "no .heading-fold-toggle found for the section");
    }

    // ── 9. Numbers never exceed the document's line count ──────────────────
    const total = await page.evaluate(() => window.__sourceLines);
    const finalRows = await painted(page);
    const beyond = finalRows.filter((r) => r.line < 1 || r.line > total);
    check(
        "no number falls outside the document's own line range",
        beyond.length === 0,
        `sourceLines=${total} out of range: ${beyond.slice(0, 5).map((r) => r.line).join(", ")}`,
    );
}
