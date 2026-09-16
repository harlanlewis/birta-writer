/**
 * The file explorer (MAR-460) against the real bundle, in the two things
 * jsdom cannot see: where the panel and the content land, and what the
 * pointer does to them. The wire and the tree are covered in
 * `webview/__tests__/fileExplorer.test.ts` and `treeModel.test.ts`; what is
 * here is the layout math in both width modes, the resize sash, the flyout,
 * the reveal of a deep file, and the keyboard through real key events.
 *
 * `index.html?root=0` is the single-file window: same profile, null root,
 * and no panel may exist.
 */
const SETTLE = 350;
const GAP = 100; // --toc-content-gap
const LEFT_PAD = 76; // --editor-content-left-padding

export async function run({ page, check, baseUrl }) {
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
    const rowSel = (path) => `.files-row[data-path="${path}"]`;
    const bodyHas = (cls) => page.evaluate((c) => document.body.classList.contains(c), cls);
    /** The bar's buttons act on mousedown (bindActivate). */
    const press = (sel) => page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    }, sel);
    const px = (v) => Math.round(parseFloat(v));

    // ── The single-file window: nothing is built ─────────────────────────
    await page.goto(`${baseUrl}/index.html?root=0`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(SETTLE);
    const single = await page.evaluate(() => ({
        panel: !!document.querySelector(".files-panel"),
        bodyClasses: [...document.body.classList].filter((c) => c.startsWith("files-")),
        barButton: !!document.querySelector(".tb-files-btn"),
        styles: !!document.getElementById("file-explorer-styles"),
        listings: window.__posted.filter((m) => m.type === "listDirectory").length,
    }));
    check("single-file window: no .files-panel is built", !single.panel);
    check("single-file window: no files-* body class, no injected stylesheet, no listing asked",
        single.bodyClasses.length === 0 && !single.styles && single.listings === 0, JSON.stringify(single));
    check("single-file window: the bar still carries the folder button (the host declares the capability)", single.barButton);
    // The chunk was never fetched: the browser has no fileExplorer script.
    const fetchedWithoutRoot = await page.evaluate(() =>
        performance.getEntriesByType("resource").some((e) => /fileExplorer/i.test(e.name)));
    check("single-file window: the explorer's chunk is never fetched", !fetchedWithoutRoot);

    // The host palette's list: answered because the stub asked, once, and it
    // names the explorer's three commands beside the palette-flagged ones.
    const palette = await posted("paletteCommands");
    const paletteIds = palette[0]?.items.map((i) => i.id) ?? [];
    check("requestPaletteCommands is answered once with the surface's runnable commands",
        palette.length === 1 && ["toggleFileExplorer", "focusFileExplorer", "toggleHiddenFiles", "toggleBold"].every((id) => paletteIds.includes(id))
            && !paletteIds.includes("tableInsertRowAbove") && !paletteIds.includes("editRawMarkdown"),
        `${palette.length} posts, ${paletteIds.length} items`);

    // ── The directory window ─────────────────────────────────────────────
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".files-panel", { timeout: 10000 });
    await page.waitForSelector(rowSel("readme.md"), { timeout: 10000 });
    await page.waitForTimeout(SETTLE);

    const geom = await page.evaluate(() => {
        const panel = document.querySelector(".files-panel").getBoundingClientRect();
        const topbar = document.querySelector(".editor-topbar").getBoundingClientRect();
        return {
            top: Math.round(panel.top), topbarBottom: Math.round(topbar.bottom),
            left: Math.round(panel.left), width: Math.round(panel.width),
            open: document.body.classList.contains("files-open"),
            docked: document.body.classList.contains("files-docked"),
            heading: document.querySelector(".files-header__name")?.textContent,
            role: document.querySelector(".files-panel").getAttribute("role"),
            tree: document.querySelector(".files-tree")?.getAttribute("role"),
        };
    });
    check("the panel docks open at load", geom.open && geom.docked, JSON.stringify(geom));
    check("the panel's top is the topbar's bottom and its left is 0",
        geom.top === geom.topbarBottom && geom.left === 0, JSON.stringify(geom));
    check("the header names the root and the landmarks are labelled",
        geom.heading === "Notes" && geom.role === "complementary" && geom.tree === "tree", JSON.stringify(geom));
    check("no differentiated background at rest: the panel is the editor's own ground",
        await page.evaluate(() => {
            const p = getComputedStyle(document.querySelector(".files-panel"));
            const b = getComputedStyle(document.body);
            return p.backgroundColor === b.backgroundColor && p.borderLeftWidth === "0px" && p.borderRightWidth === "0px";
        }));

    const rootOrder = await page.$$eval(".files-row", (els) => els.map((el) => el.dataset.path));
    check("the root lists folders first, then files, in natural order",
        JSON.stringify(rootOrder) === JSON.stringify(["assets", "docs", "locked", ".hidden.md", "notes.txt", "readme.md", "zzz.md"]),
        JSON.stringify(rootOrder));

    // ── Full-width layout: the content clears the panel ──────────────────
    const filesWidth = geom.width;
    const full = await page.evaluate(() => {
        const ed = document.querySelector("#editor");
        const cs = getComputedStyle(ed);
        return {
            marginLeft: Math.round(parseFloat(cs.marginLeft)),
            width: Math.round(ed.getBoundingClientRect().width),
            pane: ed.parentElement.clientWidth,
            reserve: getComputedStyle(document.body).getPropertyValue("--files-reserve").trim(),
            // The TOC's offset is a max() expression as a custom property and
            // reads back as its token text; the realized margin is the number.
            marginRight: Math.round(parseFloat(cs.marginRight)),
        };
    });
    const filesOffset = Math.max(0, filesWidth + GAP - LEFT_PAD);
    check("full width: --files-reserve is the panel's width", px(full.reserve) === filesWidth, JSON.stringify(full));
    check("full width: #editor's margin-left is max(0, files + gap - padding)",
        full.marginLeft === filesOffset, `expected ${filesOffset}, got ${JSON.stringify(full)}`);
    // The right TOC is docked closed: its own offset (the tab's clearance,
    // 20 + 100 - 48) comes off the width too.
    check("full width: #editor gives up both panels' offsets",
        full.marginRight === 72 && Math.abs(full.width - (full.pane - filesOffset - full.marginRight)) <= 1,
        `pane ${full.pane} files ${filesOffset} toc ${full.marginRight} width ${full.width}`);

    // ── Fixed-width layout: centred in the space the panel leaves ────────
    await page.evaluate(() => {
        document.body.classList.remove("editor-width-auto");
        document.documentElement.style.setProperty("--editor-max-width", "400px");
    });
    await page.waitForTimeout(SETTLE);
    const fixed = await page.evaluate(() => {
        const ed = document.querySelector("#editor");
        return {
            marginLeft: Math.round(parseFloat(getComputedStyle(ed).marginLeft)),
            pane: ed.parentElement.clientWidth,
            width: Math.round(ed.getBoundingClientRect().width),
        };
    });
    const centred = Math.max(filesOffset, filesWidth + (fixed.pane - filesWidth - 400) / 2);
    check("fixed width: #editor centres in the space beside the panel, the clearance as floor",
        Math.abs(fixed.marginLeft - centred) <= 1 && fixed.width === 400,
        `expected ${centred}, got ${JSON.stringify(fixed)}`);

    // A full-bleed block starts at --bw-target-left, which clears the panel.
    // `--bw-target-left` reads back as its max() token text, so the block's
    // realized edge is held to the number the formula gives: files + gap.
    const bw = await page.evaluate(() => {
        const wrapper = document.querySelector(".ProseMirror > .code-block-wrapper");
        const before = wrapper.getBoundingClientRect().left;
        wrapper.classList.add("bw-full");
        const left = wrapper.getBoundingClientRect().left;
        const target = getComputedStyle(document.querySelector("#editor")).getPropertyValue("--bw-target-left").trim();
        wrapper.classList.remove("bw-full");
        return { before: Math.round(before), left: Math.round(left), target };
    });
    check("fixed width: a bw-full block breaks out to files + gap, past the panel",
        bw.left === Math.max(LEFT_PAD, filesWidth + GAP) && bw.before > bw.left && bw.target.includes(`${filesWidth}px`),
        JSON.stringify(bw));

    // Both panels open (TOC right): centred between them in fixed mode.
    await press(".tb-toc-btn");
    await page.waitForTimeout(SETTLE);
    const both = await page.evaluate(() => {
        const ed = document.querySelector("#editor");
        const toc = document.querySelector(".toc-panel").getBoundingClientRect();
        return {
            tocOpen: document.body.classList.contains("toc-open"),
            tocWidth: Math.round(toc.width),
            marginLeft: Math.round(parseFloat(getComputedStyle(ed).marginLeft)),
            pane: ed.parentElement.clientWidth,
            right: Math.round(ed.getBoundingClientRect().right),
            tocLeft: Math.round(toc.left),
        };
    });
    const betweenCentred = Math.max(filesOffset, filesWidth + (both.pane - filesWidth - both.tocWidth - 400) / 2);
    check("fixed width, both panels: the TOC docked open on the right", both.tocOpen, JSON.stringify(both));
    check("fixed width, both panels: #editor centres between them",
        Math.abs(both.marginLeft - betweenCentred) <= 1, `expected ${betweenCentred}, got ${JSON.stringify(both)}`);
    check("fixed width, both panels: the content ends before the TOC", both.right <= both.tocLeft, JSON.stringify(both));
    await page.evaluate(() => {
        document.body.classList.add("editor-width-auto");
        document.documentElement.style.removeProperty("--editor-max-width");
    });
    await page.waitForTimeout(SETTLE);
    const fullBoth = await page.evaluate(() => {
        const ed = document.querySelector("#editor");
        const cs = getComputedStyle(ed);
        return {
            marginLeft: Math.round(parseFloat(cs.marginLeft)),
            marginRight: Math.round(parseFloat(cs.marginRight)),
            width: Math.round(ed.getBoundingClientRect().width),
            pane: ed.parentElement.clientWidth,
        };
    });
    check("full width, both panels: margin-left is the explorer's, margin-right the TOC's, width gives up both",
        fullBoth.marginLeft === filesOffset && Math.abs(fullBoth.width - (fullBoth.pane - fullBoth.marginLeft - fullBoth.marginRight)) <= 1
            && fullBoth.marginRight >= both.tocWidth + GAP - 48 - 1,
        JSON.stringify(fullBoth));
    await press(".tb-toc-btn"); // close the TOC again
    await page.waitForTimeout(SETTLE);

    // ── Expanding a folder asks for exactly one listing ──────────────────
    const listingsBefore = (await posted("listDirectory")).length;
    await page.click(rowSel("docs"));
    await page.waitForSelector(rowSel("docs/a.md"), { timeout: 5000 });
    const docsRequests = (await posted("listDirectory")).filter((m) => m.path === "docs");
    check("expanding a folder posts exactly one listDirectory for it",
        docsRequests.length === 1 && (await posted("listDirectory")).length === listingsBefore + 1,
        JSON.stringify(docsRequests));
    const nested = await page.evaluate(() => ({
        order: [...document.querySelectorAll('.files-row[data-path^="docs/"]')].map((el) => el.dataset.path),
        level: document.querySelector('.files-row[data-path="docs/a.md"]').getAttribute("aria-level"),
        indent: parseFloat(getComputedStyle(document.querySelector('.files-row[data-path="docs/a.md"]')).paddingLeft)
            - parseFloat(getComputedStyle(document.querySelector('.files-row[data-path="docs"]')).paddingLeft),
        expanded: document.querySelector('.files-row[data-path="docs"]').getAttribute("aria-expanded"),
    }));
    check("the folder's children follow it, folders first, one level deeper",
        JSON.stringify(nested.order) === JSON.stringify(["docs/guide", "docs/a.md", "docs/b.md"]) && nested.level === "2"
            && nested.indent === 12 && nested.expanded === "true",
        JSON.stringify(nested));
    // Collapse and reopen: no second request.
    await page.click(rowSel("docs"));
    await page.waitForTimeout(100);
    const collapsedGone = await page.evaluate(() => !document.querySelector('.files-row[data-path="docs/a.md"]'));
    await page.click(rowSel("docs"));
    await page.waitForTimeout(100);
    check("collapsing removes the children and reopening asks for nothing new",
        collapsedGone && (await posted("listDirectory")).filter((m) => m.path === "docs").length === 1);

    // ── Dotfiles and non-documents ───────────────────────────────────────
    const hiddenBefore = await page.evaluate(() => {
        const row = document.querySelector('.files-row[data-path=".hidden.md"]');
        return { exists: !!row, hidden: row?.hidden, drawn: row ? row.getBoundingClientRect().height > 0 : null };
    });
    check("a dotfile is in the tree but not drawn while the switch is off",
        hiddenBefore.exists && hiddenBefore.hidden === true && hiddenBefore.drawn === false, JSON.stringify(hiddenBefore));
    await page.evaluate(() => window.postMessage({ type: "fileExplorerConfig", showHidden: true }, "*"));
    await page.waitForTimeout(100);
    const hiddenAfter = await page.evaluate(() => {
        const row = document.querySelector('.files-row[data-path=".hidden.md"]');
        return { hidden: row.hidden, drawn: row.getBoundingClientRect().height > 0,
            listings: window.__posted.filter((m) => m.type === "listDirectory").length };
    });
    check("fileExplorerConfig showHidden:true draws the dotfile without a re-list",
        hiddenAfter.hidden === false && hiddenAfter.drawn && hiddenAfter.listings === listingsBefore + 1, JSON.stringify(hiddenAfter));
    const other = await page.evaluate(() => {
        const row = document.querySelector('.files-row[data-path="notes.txt"]');
        return { dimmed: row.classList.contains("files-row--other"), opacity: parseFloat(getComputedStyle(row).opacity) };
    });
    check("a non-document is dimmed", other.dimmed && other.opacity < 1, JSON.stringify(other));
    await page.click(rowSel("notes.txt"));
    const opens = await posted("openProjectFile");
    check("activating a non-document still asks the host to open it, and selects nothing",
        opens.length === 1 && opens[0].path === "notes.txt"
            && await page.evaluate(() => !document.querySelector(".files-row--selected")),
        JSON.stringify(opens));

    // ── The error folder ─────────────────────────────────────────────────
    await page.click(rowSel("locked"));
    await page.waitForSelector(".files-row--error", { timeout: 5000 });
    const err = await page.evaluate(() => {
        const row = document.querySelector(".files-row--error");
        return { text: row.textContent, level: row.getAttribute("aria-level"), path: row.dataset.path };
    });
    check("a folder the host cannot read shows its error as a row under itself",
        err.text.includes("Permission denied") && err.level === "2" && err.path === "locked", JSON.stringify(err));

    // ── A deep current file: ancestors open, the row is selected and on screen ──
    await page.evaluate(() => window.postMessage({ type: "currentProjectFile", path: "docs/guide/deep/target.md" }, "*"));
    await page.waitForSelector(`${rowSel("docs/guide/deep/target.md")}.files-row--selected`, { timeout: 5000 });
    const deep = await page.evaluate(() => {
        const row = document.querySelector('.files-row[data-path="docs/guide/deep/target.md"]');
        const tree = document.querySelector(".files-tree").getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return {
            selected: row.getAttribute("aria-selected"),
            level: row.getAttribute("aria-level"),
            onScreen: r.top >= tree.top && r.bottom <= tree.bottom,
            ancestorsOpen: ["docs", "docs/guide", "docs/guide/deep"].every((p) =>
                document.querySelector(`.files-row[data-path="${p}"]`)?.getAttribute("aria-expanded") === "true"),
            selectedCount: document.querySelectorAll(".files-row--selected").length,
            guideRequests: window.__posted.filter((m) => m.type === "listDirectory" && m.path === "docs/guide").length,
            deepRequests: window.__posted.filter((m) => m.type === "listDirectory" && m.path === "docs/guide/deep").length,
        };
    });
    check("currentProjectFile four levels down opens every ancestor and selects the one row",
        deep.selected === "true" && deep.level === "4" && deep.ancestorsOpen && deep.selectedCount === 1, JSON.stringify(deep));
    check("the reveal listed each missing ancestor exactly once", deep.guideRequests === 1 && deep.deepRequests === 1, JSON.stringify(deep));
    check("the selected row is inside the tree's scroller", deep.onScreen, JSON.stringify(deep));

    // ── Resize: the sash lights on hover, the drag writes the width, mouseup posts it ──
    const sash = await page.evaluate(() => {
        const h = document.querySelector(".files-panel .side-panel-resize-handle").getBoundingClientRect();
        return { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + 200) };
    });
    await page.mouse.move(sash.x, sash.y);
    await page.waitForTimeout(200);
    const edge = await page.evaluate(() => {
        const after = getComputedStyle(document.querySelector(".files-panel .side-panel-resize-handle"), "::after");
        return { opacity: parseFloat(after.opacity), width: after.width };
    });
    check("hovering the panel's edge lights the resize sash", edge.opacity === 1 && edge.width === "2px", JSON.stringify(edge));
    const widthBefore = await page.evaluate(() => document.querySelector(".files-panel").getBoundingClientRect().width);
    await page.mouse.down();
    await page.mouse.move(sash.x + 30, sash.y, { steps: 3 });
    await page.mouse.move(sash.x + 60, sash.y, { steps: 3 });
    const widthMid = await page.evaluate(() => ({
        panel: Math.round(document.querySelector(".files-panel").getBoundingClientRect().width),
        varPx: document.documentElement.style.getPropertyValue("--files-width"),
        posted: window.__posted.filter((m) => m.type === "fileExplorerWidth").length,
        editorMl: Math.round(parseFloat(getComputedStyle(document.querySelector("#editor")).marginLeft)),
    }));
    await page.mouse.up();
    await page.waitForTimeout(100);
    const widthAfter = await page.evaluate(() => ({
        panel: Math.round(document.querySelector(".files-panel").getBoundingClientRect().width),
        posted: window.__posted.filter((m) => m.type === "fileExplorerWidth"),
    }));
    check("dragging the sash widens the panel and writes --files-width per move, posting nothing yet",
        widthMid.panel === Math.round(widthBefore) + 60 && widthMid.varPx === `${Math.round(widthBefore) + 60}px` && widthMid.posted === 0,
        JSON.stringify({ widthBefore, widthMid }));
    check("the editor's margin follows the drag live",
        widthMid.editorMl === Math.max(0, Math.round(widthBefore) + 60 + GAP - LEFT_PAD), JSON.stringify(widthMid));
    check("mouseup posts fileExplorerWidth once, with the settled width",
        widthAfter.posted.length === 1 && widthAfter.posted[0].width === widthAfter.panel && widthAfter.panel === Math.round(widthBefore) + 60,
        JSON.stringify(widthAfter));

    // ── The bar button: toggle, then hover flyout while closed ───────────
    await press(".tb-files-btn");
    await page.waitForTimeout(SETTLE);
    const closed = await page.evaluate(() => ({
        open: document.body.classList.contains("files-open"),
        visibility: window.__posted.filter((m) => m.type === "fileExplorerVisibility"),
        marginLeft: Math.round(parseFloat(getComputedStyle(document.querySelector("#editor")).marginLeft)),
        pressed: getComputedStyle(document.querySelector(".tb-files-btn")).backgroundColor,
    }));
    check("the bar button closes the panel, posts the choice, and the content takes the room back",
        !closed.open && closed.visibility.length === 1 && closed.visibility[0].visible === false && closed.marginLeft === 0,
        JSON.stringify(closed));
    await page.mouse.move(600, 500); // rest the pointer off the bar first
    await page.waitForTimeout(100);
    await page.locator(".tb-files-btn").hover();
    await page.waitForTimeout(SETTLE);
    const flyout = await page.evaluate(() => {
        const panel = document.querySelector(".files-panel");
        const r = panel.getBoundingClientRect();
        const btn = document.querySelector(".tb-files-btn").getBoundingClientRect();
        return {
            flyout: panel.classList.contains("files-panel--flyout-in"),
            open: document.body.classList.contains("files-open"),
            bodyFlag: document.body.classList.contains("files-flyout-open"),
            belowButton: r.top > btn.bottom,
            rows: panel.querySelectorAll(".files-row").length,
            controlsHidden: getComputedStyle(panel.querySelector(".side-panel-controls")).display === "none",
        };
    });
    check("hovering the bar button flies the panel out below it, transiently, with its rows",
        flyout.flyout && !flyout.open && flyout.bodyFlag && flyout.belowButton && flyout.rows > 3 && flyout.controlsHidden,
        JSON.stringify(flyout));
    await page.mouse.move(600, 600);
    await page.waitForTimeout(500);
    const retracted = await page.evaluate(() => ({
        flyout: document.querySelector(".files-panel").classList.contains("files-panel--flyout"),
        bodyFlag: document.body.classList.contains("files-flyout-open"),
    }));
    check("leaving the button and the card retracts the flyout", !retracted.flyout && !retracted.bodyFlag, JSON.stringify(retracted));
    await press(".tb-files-btn");
    await page.waitForTimeout(SETTLE);
    check("the bar button opens it again and posts that too",
        await bodyHas("files-open") && (await posted("fileExplorerVisibility")).length === 2);

    // ── Keyboard: real key events through the roving tree ────────────────
    await page.evaluate(() => {
        document.querySelector('.files-row[data-path="assets"]').focus();
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForSelector(rowSel("assets/logo.png"), { timeout: 5000 });
    const afterRight = await page.evaluate(() => ({
        expanded: document.querySelector('.files-row[data-path="assets"]').getAttribute("aria-expanded"),
        active: document.activeElement?.dataset?.path,
    }));
    check("ArrowRight on a closed folder opens it and keeps focus on it",
        afterRight.expanded === "true" && afterRight.active === "assets", JSON.stringify(afterRight));
    await page.keyboard.press("ArrowRight");
    const child = await page.evaluate(() => document.activeElement?.dataset?.path);
    check("ArrowRight on an open folder moves to its first child", child === "assets/logo.png", String(child));
    await page.keyboard.press("ArrowLeft");
    const parent = await page.evaluate(() => document.activeElement?.dataset?.path);
    check("ArrowLeft on a child climbs to its folder", parent === "assets", String(parent));
    await page.keyboard.press("ArrowLeft");
    const afterLeft = await page.evaluate(() => ({
        expanded: document.querySelector('.files-row[data-path="assets"]').getAttribute("aria-expanded"),
        childGone: !document.querySelector('.files-row[data-path="assets/logo.png"]'),
    }));
    check("ArrowLeft on an open folder closes it", afterLeft.expanded === "false" && afterLeft.childGone, JSON.stringify(afterLeft));
    await page.keyboard.press("End");
    const last = await page.evaluate(() => document.activeElement?.dataset?.path);
    check("End moves to the last visible row", last === "zzz.md", String(last));
    await page.keyboard.press("Enter");
    const enterOpens = await posted("openProjectFile");
    check("Enter on a file row asks the host to open it",
        enterOpens.length === 2 && enterOpens[1].path === "zzz.md", `${JSON.stringify(enterOpens)}`);
    await page.keyboard.press("Escape");
    check("Escape returns focus to the editor",
        await page.evaluate(() => !!document.activeElement?.closest(".ProseMirror")));
}
