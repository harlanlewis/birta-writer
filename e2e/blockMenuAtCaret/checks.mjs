/**
 * The keyboard path into the block menu (⌘. / birta.editor.openBlockMenu,
 * components/blockMenu/openAtCaret.ts) on blocks NESTED inside a callout,
 * driven against the production NodeViews. The resolver picks the block whose
 * DOM owns a gutter marker by a posAtDOM round trip; jsdom exercises that with
 * plain ProseMirror rendering only, so this is where the real code block and
 * table NodeViews (chrome wrappers, controls columns) prove the round trip
 * still lands on the nested block's own marker rather than the callout's.
 *
 *   - caret in a callout-nested code block: the menu anchors to the code
 *     block's marker, not the callout's,
 *   - caret in a callout-nested table cell: the menu anchors to the table's
 *     marker and carries the caret's cell (a leading Table section),
 *   - a node-selected nested code block (Backspace at the start of the
 *     paragraph after it, the product's own select-the-block gesture) anchors
 *     to the code block, not the callout (MAR-119: a NodeSelection's $head
 *     sits after the node, so its ancestor chain starts at the container).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);

    const settle = () =>
        page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const openMenu = async () => {
        await page.evaluate(() =>
            window.postMessage({ type: "editorCommand", command: "openBlockMenu" }, "*"));
        await settle();
        return page.evaluate(() => {
            const menu = document.querySelector(".block-menu");
            const anchor = document.querySelector(".heading-fold-marker--menu-open");
            return {
                open: !!menu,
                pill: anchor?.dataset.pill ?? null,
                inPre: !!anchor?.closest("pre"),
                inCallout: !!anchor?.closest(".callout"),
                inTable: !!anchor?.closest("table, .table-wrapper, .tableWrapper"),
                headers: menu
                    ? [...menu.querySelectorAll(".block-menu-header")].map((h) => h.textContent)
                    : [],
            };
        });
    };
    const closeMenu = async () => {
        await page.keyboard.press("Escape");
        await settle();
        // The anchor marker keeps focus after Escape (keyboard mode); park
        // the caret back in prose so the next gesture starts clean.
        await page.click(".ProseMirror > p");
        await settle();
    };

    // ── 1. Caret inside the nested code block ──
    await page.click(".ProseMirror .callout pre code");
    await settle();
    let r = await openMenu();
    check("caret in a nested code block opens a menu", r.open, JSON.stringify(r));
    check("…anchored to the code block's own marker, inside the callout",
        r.inPre && r.inCallout && r.pill !== "Callout", JSON.stringify(r));
    await closeMenu();

    // ── 2. Caret inside the nested table ──
    await page.click(".ProseMirror .callout td, .ProseMirror .callout th");
    await settle();
    r = await openMenu();
    check("caret in a nested table cell opens a menu", r.open, JSON.stringify(r));
    check("…anchored to the table's marker, carrying the caret's cell",
        r.pill === "Table" && r.headers.includes("Table"), JSON.stringify(r));
    await closeMenu();

    // ── 3. Node-selected nested code block ──
    // The product's own gesture: Backspace at the start of the paragraph that
    // follows a code block selects the block instead of entering it
    // (plugins/codeBlockBackspace.ts), at any depth. Clicking the block's
    // frame cannot do it: the pre fills the wrapper and the rest is chrome.
    await page.click(".ProseMirror .callout .code-block-wrapper + p");
    // Collapse the DOM selection to the paragraph's very start (Home scrolls
    // rather than moves on a Mac keyboard layout).
    await page.evaluate(() => {
        const p = document.querySelector(".ProseMirror .callout .code-block-wrapper + p");
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await settle();
    await page.keyboard.press("Backspace");
    await settle();
    // The selected node is the code block's own wrapper (the NodeView's dom),
    // inside the callout: a caret that merely entered the code would carry no
    // selectednode class and the next check could pass for the wrong reason.
    const selected = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .ProseMirror-selectednode");
        return el
            ? { isCodeWrapper: el.classList.contains("code-block-wrapper"), inCallout: !!el.closest(".callout") }
            : null;
    });
    check("Backspace after the nested code block node-selects it",
        !!selected && selected.isCodeWrapper && selected.inCallout, JSON.stringify(selected));
    r = await openMenu();
    check("node-selected nested code block opens the CODE BLOCK's menu, not the callout's",
        r.open && r.inPre && r.pill !== "Callout", JSON.stringify(r));
    await closeMenu();
}
