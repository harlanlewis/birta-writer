/**
 * Editable HTML end-to-end (MAR-14), against the real bundle: a real click
 * on the html atom opens the source panel, a real blur commits, and the
 * committed bytes reach the serialized document the webview posts out.
 * Also pins the live-pair rendering jsdom can only assert structurally:
 * the decoration spans exist with their classes in a painted layout.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    // Live pair painted: the text between <kbd>...</kbd> carries the class.
    const kbdLive = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .html-live-kbd");
        return el ? el.textContent : null;
    });
    check("the <kbd> pair renders live", kbdLive === "Ctrl", String(kbdLive));

    const pairedTags = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror .html-tag--paired").length);
    check("both tag atoms are dimmed chips", pairedTags === 2, String(pairedTags));

    // A real click on the comment chip opens the source panel.
    await page.click(".ProseMirror .html-comment");
    const areaVisible = await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    check("clicking the comment chip opens the source panel", !!areaVisible, "no textarea");

    const raw = await page.evaluate(() =>
        document.querySelector(".ProseMirror textarea.html-src").value);
    check("the panel holds the raw comment bytes", raw === "<!-- editorial -->", raw);

    // Type a new value and commit by clicking back into the document.
    await page.evaluate(() => {
        const area = document.querySelector(".ProseMirror textarea.html-src");
        area.value = "<!-- reviewed -->";
    });
    await page.click(".ProseMirror p");
    await page.waitForTimeout(600);

    const doc = await latest();
    check("the committed bytes reach the serialized document",
        doc !== null && doc.includes("<!-- reviewed -->") && !doc.includes("<!-- editorial -->"),
        String(doc));

    check("the pair bytes are untouched by decoration",
        doc !== null && doc.includes("Press <kbd>Ctrl</kbd> to run."),
        String(doc));

    // The panel is gone after the commit.
    const areaGone = await page.evaluate(() =>
        document.querySelector(".ProseMirror textarea.html-src") === null);
    check("the panel closes on commit", areaGone, "textarea still present");

    // ── The code surface's geometry, which jsdom cannot see ──────────────
    //
    // The panel is measured from its highlight layer rather than from a row
    // count, so the two layers must coincide exactly and the textarea must
    // never have content scrolled out of sight.
    const boxes = async () => page.evaluate(() => {
        const area = document.querySelector(".ProseMirror textarea.html-src");
        const mirror = document.querySelector(".ProseMirror .html-src-mirror");
        const panel = document.querySelector(".ProseMirror .html-src-panel");
        const note = document.querySelector(".ProseMirror .html-src-note");
        if (!area || !mirror || !panel) return null;
        const a = area.getBoundingClientRect();
        const m = mirror.getBoundingClientRect();
        return {
            area: { top: a.top, left: a.left, width: a.width, height: a.height },
            mirror: { top: m.top, left: m.left, width: m.width, height: m.height },
            scrollHeight: area.scrollHeight,
            clientHeight: area.clientHeight,
            // CONTENT heights, which is where the layers can actually diverge.
            // Their boxes cannot: the textarea is `inset: 0` inside a wrapper
            // the mirror sizes, so comparing those two is comparing a value
            // with itself.
            areaContent: area.scrollHeight,
            mirrorContent: mirror.scrollHeight,
            block: panel.classList.contains("html-src-panel--block"),
            noteShown: note ? getComputedStyle(note).display !== "none" : false,
            editorWidth: document.querySelector(".ProseMirror p").getBoundingClientRect().width,
        };
    });

    // The block face: the whole line of HTML, opened as a code block.
    await page.click(".ProseMirror .html-inline[data-type=html] strong");
    await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    await page.waitForTimeout(150);
    const blockBox = await boxes();
    check("an atom that is the whole of its block opens the block face",
        blockBox !== null && blockBox.block, JSON.stringify(blockBox));
    check("the block face spans the content column",
        blockBox !== null && blockBox.area.width > blockBox.editorWidth * 0.9,
        JSON.stringify(blockBox));
    check("no source is scrolled out of the box",
        blockBox !== null && blockBox.scrollHeight <= blockBox.clientHeight + 1,
        JSON.stringify(blockBox));
    check("the highlight layer wraps to the same height as the textarea",
        blockBox !== null && Math.abs(blockBox.areaContent - blockBox.mirrorContent) <= 1,
        JSON.stringify(blockBox));
    check("the highlight layer sits exactly under the textarea",
        blockBox !== null
            && Math.abs(blockBox.area.top - blockBox.mirror.top) < 1
            && Math.abs(blockBox.area.left - blockBox.mirror.left) < 1
            && Math.abs(blockBox.area.width - blockBox.mirror.width) < 1
            && Math.abs(blockBox.area.height - blockBox.mirror.height) < 1,
        JSON.stringify(blockBox));
    check("the block face shows its hint row", blockBox !== null && blockBox.noteShown,
        JSON.stringify(blockBox));

    const tokens = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror .html-src-mirror span.token").length);
    check("the source is syntax-highlighted", tokens > 0, String(tokens));

    // One source line, long enough to wrap several times: the case a row count
    // cannot see. The box has to grow with the WRAPPED height.
    await page.evaluate(() => {
        const area = document.querySelector(".ProseMirror textarea.html-src");
        area.value = `<div align="center">${"long ".repeat(120)}</div>`;
        area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const wrapped = await boxes();
    check("a single wrapped line still gets every row it needs",
        wrapped !== null
            && wrapped.area.height > blockBox.area.height * 3
            && wrapped.scrollHeight <= wrapped.clientHeight + 1
            && Math.abs(wrapped.area.height - wrapped.mirror.height) < 1,
        JSON.stringify(wrapped));

    // Emptied: the one value with no line boxes to size the mirror, so
    // `min-height` alone decides. It has to leave room for the caret line
    // AND the shared padding, since both layers are border-box.
    await page.evaluate(() => {
        const area = document.querySelector(".ProseMirror textarea.html-src");
        area.value = "";
        area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(150);
    const emptied = await boxes();
    check("an emptied value still shows its whole caret line",
        emptied !== null
            && emptied.scrollHeight <= emptied.clientHeight + 1
            && Math.abs(emptied.area.height - emptied.mirror.height) < 1,
        JSON.stringify(emptied));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // The inline face: an atom inside prose stays inside its line.
    await page.click(".ProseMirror .html-comment");
    await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    await page.waitForTimeout(150);
    const inlineBox = await boxes();
    check("a tag inside prose opens the inline face",
        inlineBox !== null && !inlineBox.block, JSON.stringify(inlineBox));
    check("the inline face hugs its bytes instead of spanning the column",
        inlineBox !== null && inlineBox.area.width < inlineBox.editorWidth * 0.5,
        JSON.stringify(inlineBox));
    check("the inline face keeps the hint row out of the line",
        inlineBox !== null && !inlineBox.noteShown, JSON.stringify(inlineBox));
    check("the inline layers coincide too",
        inlineBox !== null
            && Math.abs(inlineBox.area.height - inlineBox.mirror.height) < 1
            && inlineBox.scrollHeight <= inlineBox.clientHeight + 1,
        JSON.stringify(inlineBox));

    // The comment chip's resting styles are the atom's, not the panel's. Left
    // on, they dim the whole editing surface and compound its font size, which
    // reads as a broken control rather than a quiet chip.
    const chipLeak = await page.evaluate(() => {
        // Read the HOST atom, not the panel: opacity and background are the
        // chip's own, and opacity does not inherit, so the panel's computed
        // value is 1 however dimmed it actually renders.
        const host = document.querySelector(".ProseMirror .html-inline--editing");
        const s = getComputedStyle(host);
        const mirror = getComputedStyle(document.querySelector(".ProseMirror .html-src-mirror"));
        const body = getComputedStyle(document.querySelector(".ProseMirror p"));
        return {
            opacity: s.opacity,
            background: s.backgroundColor,
            mirrorPx: parseFloat(mirror.fontSize),
            bodyPx: parseFloat(body.fontSize),
        };
    });
    check("the editing surface is not dimmed by the chip it replaced",
        chipLeak.opacity === "1", JSON.stringify(chipLeak));
    check("the source is not shrunk twice over",
        // 0.9em of content. Compounding the chip's 0.85em too lands near 0.77.
        Math.abs(chipLeak.mirrorPx / chipLeak.bodyPx - 0.9) < 0.02, JSON.stringify(chipLeak));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // An atom alone in a table cell is not a "whole block": a full-width block
    // face with its own margins deforms the row it sits in.
    await page.click(".ProseMirror table .html-inline[data-type=html]");
    await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    await page.waitForTimeout(150);
    const cellBox = await page.evaluate(() => {
        const panel = document.querySelector(".ProseMirror .html-src-panel");
        const cell = panel.closest("td, th");
        return {
            block: panel.classList.contains("html-src-panel--block"),
            panelWidth: panel.getBoundingClientRect().width,
            cellWidth: cell ? cell.getBoundingClientRect().width : null,
        };
    });
    check("an atom alone in a table cell opens the inline face",
        cellBox.block === false, JSON.stringify(cellBox));

    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    // Mode-switch story (selectionSurfaceCoverage's ISLAND_REGISTRY entry):
    // with the panel open, the parked ProseMirror selection is a
    // NodeSelection on the atom itself, so a switch targets the atom's own
    // source line — the comment paragraph is body line 3 — and
    // getSwitchTarget blurs the panel first, so a mid-edit value is
    // committed rather than discarded, even with no natural blur.
    await page.click(".ProseMirror .html-comment");
    await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    await page.evaluate(() => {
        document.querySelector(".ProseMirror textarea.html-src").value = "<!-- switched away -->";
    });
    await page.evaluate(() => window.postMessage({ type: "requestSwitchToTextEditor" }, "*"));
    await page.waitForTimeout(600);
    const switchTarget = await page.evaluate(() => {
        const posted = window.__posted.filter((m) => m.type === "switchToTextEditor");
        return posted[posted.length - 1] ?? null;
    });
    check("a switch from the open panel targets the html atom's line",
        switchTarget !== null && switchTarget.line === 3,
        JSON.stringify(switchTarget));
    const afterSwitch = await latest();
    check("a mid-edit panel value is committed by the switch, not discarded",
        afterSwitch !== null && afterSwitch.includes("<!-- switched away -->"),
        String(afterSwitch));
}
