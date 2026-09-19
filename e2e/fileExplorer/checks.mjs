/**
 * The file explorer (MAR-460) against the real bundle, in the two things
 * jsdom cannot see: where the panel and the content land, and what the
 * pointer does to them. The wire and the tree are covered in
 * `webview/__tests__/fileExplorer.test.ts` and `treeModel.test.ts`; what is
 * here is the layout math in both width modes, the resize sash, the flyout,
 * the reveal of a deep file, and the keyboard through real key events.
 *
 * `index.html?root=0` is the single-file window: same profile, null root,
 * and no panel may exist. `index.html?toc=left` is the VS Code-shaped
 * pairing, a left TOC with its reveal tab on the explorer's own edge, where
 * the content clears both drawers through one margin and the tab has to
 * clear the explorer.
 */
const SETTLE = 350;
const GAP = 100; // --toc-content-gap
const LEFT_PAD = 76; // --editor-content-left-padding
// How far a drawer stands in from the edge it is docked against
// (SIDE_PANEL_INSET in components/sidePanel/shell.ts). BOTH drawers take it,
// and it comes out of each one's OWN box: the reserve a drawer takes, which
// every margin below is measured from, is its far edge rather than its rect
// width. For the TOC docked beside an open explorer, the edge it stands in
// from is the explorer's far edge and not the window's.
const INSET = 8;

export async function run({ page, check, baseUrl }) {
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
    const rowSel = (path) => `.files-row[data-path="${path}"]`;
    const bodyHas = (cls) => page.evaluate((c) => document.body.classList.contains(c), cls);
    /** The bar's buttons act on mousedown (bindActivate). */
    const press = (sel) => page.evaluate((s) => {
        document.querySelector(s).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    }, sel);
    const px = (v) => Math.round(parseFloat(v));
    /**
     * Turn the formatting row on or off. The host's setting is the only route:
     * the row has no control of its own on the page, so this is what the
     * shell's Settings window does (`setFormattingRowExpanded`).
     */
    const setFormattingRow = (on) => page.evaluate(
        (v) => { window.postMessage({ type: "setFormattingRowExpanded", expanded: v }, "*"); }, on);

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
        const el = document.querySelector(".files-panel");
        const panel = el.getBoundingClientRect();
        const topbar = document.querySelector(".editor-topbar").getBoundingClientRect();
        // The ground and the radius are the CARD's: the panel is its box and
        // keeps a strip of page beside it for the sash.
        const cs = getComputedStyle(el.querySelector(".files-card"));
        return {
            top: Math.round(panel.top), topbarBottom: Math.round(topbar.bottom),
            left: Math.round(panel.left), width: Math.round(panel.width), right: Math.round(panel.right),
            bottom: Math.round(panel.bottom), viewportHeight: window.innerHeight,
            inset: el.style.getPropertyValue("--side-panel-inset"),
            reserve: getComputedStyle(document.body).getPropertyValue("--files-reserve").trim(),
            radius: cs.borderRadius,
            background: cs.backgroundColor,
            sideBar: getComputedStyle(document.documentElement).getPropertyValue("--vscode-sideBar-background").trim(),
            bodyBackground: getComputedStyle(document.body).backgroundColor,
            borders: [cs.borderLeftWidth, cs.borderRightWidth, cs.borderTopWidth, cs.borderBottomWidth],
            open: document.body.classList.contains("files-open"),
            docked: document.body.classList.contains("files-docked"),
            heading: document.querySelector(".files-header__name")?.textContent,
            role: document.querySelector(".files-panel").getAttribute("role"),
            tree: document.querySelector(".files-tree")?.getAttribute("role"),
        };
    });
    check("the panel docks open at load", geom.open && geom.docked, JSON.stringify(geom));
    // The formatting row is collapsed on this page, so the content area's top
    // is the bar's bottom; the panel is FLUSH with it, stands in from the
    // window's left and bottom edges by its inset, and runs the height
    // between them whatever the tree holds. Flush at the top because the
    // chrome above is the window's rather than an edge (shell.ts,
    // `updatePosition`).
    check("the panel hangs from the bar and stands in from the window's other edges",
        geom.inset === `${INSET}px` && geom.top === geom.topbarBottom && geom.left === INSET
            && geom.bottom === geom.viewportHeight - INSET,
        JSON.stringify(geom));
    check("the inset comes out of the panel's own box: its far edge is the reserve the content reads",
        geom.right === px(geom.reserve) && geom.width === px(geom.reserve) - INSET, JSON.stringify(geom));
    check("the header names the root and the landmarks are labelled",
        geom.heading === "Notes" && geom.role === "complementary" && geom.tree === "tree", JSON.stringify(geom));
    check("the root's name is drawn quieter than the rows under it",
        await page.evaluate(() => {
            const name = getComputedStyle(document.querySelector(".files-header__name"));
            const row = getComputedStyle(document.querySelector(".files-row__name"));
            const probe = document.createElement("div");
            probe.style.color = "var(--vscode-descriptionForeground)";
            document.body.appendChild(probe);
            const quiet = getComputedStyle(probe).color;
            probe.remove();
            return name.color === quiet && name.color !== row.color;
        }));
    // Its own ground, a step off the page: the sidebar shade the palette
    // derives from the widget ground (darker on light, lighter on dark), a
    // small radius on the corners that stand in from the window, square on
    // the two that meet the chrome above, and still no border. A rounded
    // corner against the bar leaves a notch of page under the toolbar, which
    // reads as a rendering fault rather than as a shape.
    check("the panel draws the sidebar ground, rounded below and square where it meets the bar, with no border",
        geom.background !== geom.bodyBackground && geom.sideBar !== ""
            && geom.radius === "0px 0px 6px 6px"
            && geom.borders.every((b) => b === "0px"),
        JSON.stringify(geom));
    check("and that ground is the palette's sidebar shade, not a literal of its own",
        await page.evaluate(() => {
            const probe = document.createElement("div");
            probe.style.background = "var(--vscode-sideBar-background)";
            document.body.appendChild(probe);
            const same = getComputedStyle(probe).backgroundColor === getComputedStyle(document.querySelector(".files-card")).backgroundColor;
            probe.remove();
            return same;
        }));
    // The shade is the DEFAULT, and a host can move it: the Mac app's
    // Transparent file list sidebar declares --files-panel-ground so the card
    // reads as page. A sentinel colour rather than the paper, so the check
    // cannot pass by the card having been the paper all along; which colour
    // the app puts there is its own to say, and its tests do.
    const CARD_GROUND = "rgb(1, 2, 3)";
    const moved = await page.evaluate((value) => {
        const style = document.createElement("style");
        style.textContent = `:root { --files-panel-ground: ${value}; }`;
        document.head.appendChild(style);
        const seen = getComputedStyle(document.querySelector(".files-card")).backgroundColor;
        style.remove();
        const back = getComputedStyle(document.querySelector(".files-card")).backgroundColor;
        return { seen, back };
    }, CARD_GROUND);
    check("one declaration moves the card's ground, and taking it away hands the shade back",
        moved.seen === CARD_GROUND && moved.back === geom.background, JSON.stringify(moved));

    // The formatting row is the top of the CONTENT AREA, beside the panel:
    // opened, it starts where the panel ends, and its controls' top edge is
    // the panel's top edge, so the two draw one line under the window's chrome.
    await setFormattingRow(true);
    await page.waitForTimeout(SETTLE);
    const rowBeside = await page.evaluate(() => {
        const panel = document.querySelector(".files-panel").getBoundingClientRect();
        const dock = document.querySelector(".tb-dock").getBoundingClientRect();
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const item = document.querySelector(".tb-dock-row .tb-item")?.getBoundingClientRect();
        return {
            expanded: document.querySelector(".tb-dock")?.dataset.expanded,
            panelTop: Math.round(panel.top), panelRight: Math.round(panel.right),
            dockLeft: Math.round(dock.left), dockTop: Math.round(dock.top), dockBottom: Math.round(dock.bottom),
            itemTop: item ? Math.round(item.top) : null,
            barBottom: Math.round(bar.bottom),
        };
    });
    check("the formatting row opens on this page", rowBeside.expanded === "true", JSON.stringify(rowBeside));
    check("the open row starts where the panel ends, and the panel starts level with the row, not under it",
        rowBeside.dockLeft === rowBeside.panelRight && rowBeside.panelTop === rowBeside.dockTop
            // The bar's own hairline sits under the row.
            && rowBeside.barBottom - rowBeside.dockBottom <= 1,
        JSON.stringify(rowBeside));
    check("the row's controls sit on the panel's top edge",
        rowBeside.itemTop !== null && Math.abs(rowBeside.itemTop - rowBeside.panelTop) <= 1, JSON.stringify(rowBeside));
    // Level with the row is a claim about two boxes, and the bar is a third:
    // it is the width of the window and stacks above the panel, so whatever it
    // paints beside the row is painted over the panel's top. Where the boxes
    // are cannot see that. What is AT the panel's header can, and so can a
    // pixel of the bar's own box beside the row, which must not be the bar.
    const panelTopIsThePanels = await page.evaluate(() => {
        const panel = document.querySelector(".files-panel");
        const header = panel.querySelector(".files-header").getBoundingClientRect();
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const at = document.elementFromPoint(header.left + header.width / 2, header.top + header.height / 2);
        return {
            headerInsideBarBox: header.top < bar.bottom,
            hit: at ? (at.className || at.tagName) : null,
            hitIsPanel: !!at && panel.contains(at),
            barGround: getComputedStyle(document.querySelector(".editor-topbar")).backgroundColor,
            rowGround: getComputedStyle(document.querySelector(".tb-dock")).backgroundColor,
            firstRowGround: getComputedStyle(document.querySelector(".editor-topbar .toolbar")).backgroundColor,
        };
    });
    check("the probe is asking about a header that really is inside the bar's box",
        panelTopIsThePanels.headerInsideBarBox, JSON.stringify(panelTopIsThePanels));
    check("beside the open row, the panel's header is the panel's: the bar neither covers it nor takes its clicks",
        panelTopIsThePanels.hitIsPanel, JSON.stringify(panelTopIsThePanels));
    check("the bar's ground is its rows', so there is nothing of the bar's to paint over the panel",
        /rgba\(0, 0, 0, 0\)|transparent/.test(panelTopIsThePanels.barGround)
            && panelTopIsThePanels.rowGround === panelTopIsThePanels.firstRowGround
            && !/rgba\(0, 0, 0, 0\)|transparent/.test(panelTopIsThePanels.rowGround),
        JSON.stringify(panelTopIsThePanels));
    await setFormattingRow(false);
    await page.waitForTimeout(SETTLE);

    const rootOrder = await page.$$eval(".files-row", (els) => els.map((el) => el.dataset.path));
    check("the root lists folders first, then files, in natural order",
        JSON.stringify(rootOrder) === JSON.stringify(["assets", "docs", "locked", ".hidden.md", "notes.txt", "readme.md", "zzz.md"]),
        JSON.stringify(rootOrder));

    // ── Full-width layout: the content clears the panel ──────────────────
    // The panel's far edge, which is `--files-width`: the inset comes out of
    // the panel's box, so its rect width is that less the inset.
    const filesWidth = geom.right;
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

    // ── The line-number gutter clears the panel ──────────────────────────
    // The gutter is a layer at the viewport's start edge, under the docked
    // panel's z-index; with the explorer docked open it sits past the
    // panel's far edge rather than beneath it (components/lineNumbers/styles.ts).
    await page.evaluate(() => window.postMessage({ type: "setLineNumbers", enabled: true }, "*"));
    // Attached, not visible: the layer is a zero-height box by design.
    await page.waitForSelector(".line-number-layer", { state: "attached", timeout: 5000 });
    await page.waitForTimeout(SETTLE);
    const gutter = await page.evaluate(() => {
        const layer = document.querySelector(".line-number-layer");
        const panel = document.querySelector(".files-panel");
        return {
            layerLeft: Math.round(layer.getBoundingClientRect().left),
            panelRight: Math.round(panel.getBoundingClientRect().right),
            numbers: document.querySelectorAll(".line-number").length,
        };
    });
    check("line numbers: the gutter starts past the docked explorer's far edge",
        gutter.layerLeft >= gutter.panelRight && gutter.numbers > 0, JSON.stringify(gutter));
    await page.evaluate(() => window.postMessage({ type: "setLineNumbers", enabled: false }, "*"));
    await page.waitForTimeout(SETTLE);

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

    // At the runner's width the TOC cannot dock beside the docked explorer
    // (1000 - 220 leaves less than the TOC's 260 + 720), so opening it floats
    // it: the decision is re-made when the explorer's reserve landed, not
    // left as it stood at load with no explorer yet.
    await press(".tb-toc-btn");
    await page.waitForTimeout(SETTLE);
    const floated = await page.evaluate(() => ({
        docked: document.body.classList.contains("toc-open"),
        overlayOpen: document.body.classList.contains("toc-overlay-open"),
        marginLeft: Math.round(parseFloat(getComputedStyle(document.querySelector("#editor")).marginLeft)),
    }));
    check("fixed width, both panels at the runner's width: the TOC floats rather than docking into the content",
        !floated.docked && floated.overlayOpen && Math.abs(floated.marginLeft - centred) <= 1, JSON.stringify(floated));
    // A FLOATED panel is not beside the formatting row: the row carries no
    // margin for it and paints above it, so with the row open the panel has
    // to start below the whole bar, not at the row's edge as a docked one does.
    await setFormattingRow(true);
    await page.waitForTimeout(SETTLE);
    const floatedUnderRow = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel").getBoundingClientRect();
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        const dock = document.querySelector(".tb-dock");
        return {
            overlayOpen: document.body.classList.contains("toc-overlay-open"),
            rowShown: !!dock && !dock.hidden && dock.getBoundingClientRect().height > 0,
            panelTop: Math.round(panel.top), barBottom: Math.round(bar.bottom),
        };
    });
    check("with the row open, the floated TOC starts below the whole bar rather than under the row",
        floatedUnderRow.overlayOpen && floatedUnderRow.rowShown && floatedUnderRow.panelTop >= floatedUnderRow.barBottom,
        JSON.stringify(floatedUnderRow));
    await setFormattingRow(false);
    await page.waitForTimeout(SETTLE);
    await press(".tb-toc-btn"); // close the floating TOC
    await page.waitForTimeout(SETTLE);

    // Both panels docked open (TOC right), on a viewport that holds them:
    // centred between them in fixed mode.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(SETTLE);
    await press(".tb-toc-btn");
    await page.waitForTimeout(SETTLE);
    const both = await page.evaluate(() => {
        const ed = document.querySelector("#editor");
        const toc = document.querySelector(".toc-panel").getBoundingClientRect();
        return {
            tocOpen: document.body.classList.contains("toc-open"),
            // The room the drawer takes, not the box it draws: both drawers
            // stand in from the edge they are docked against, and that inset
            // comes out of their own width. Docked right, the room runs from
            // the drawer's near edge to the window's, which is what the
            // content's margin has to clear.
            tocWidth: Math.round(window.innerWidth - toc.left),
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
    await page.setViewportSize({ width: 1000, height: 900 });
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
        return {
            dimmed: row.classList.contains("files-row--other"),
            // The NAME is what is dimmed; the row itself stays at full
            // strength, or the chip drawn inside it would dim with it.
            opacity: parseFloat(getComputedStyle(row.querySelector(".files-row__name")).opacity),
            rowOpacity: parseFloat(getComputedStyle(row).opacity),
        };
    });
    check("a non-document's name is dimmed, and its row is not", other.dimmed && other.opacity < 1 && other.rowOpacity === 1,
        JSON.stringify(other));
    // Hovered, the row says what the file is: its extension, in a chip over
    // the name's trailing end. An openable row shows none.
    await page.hover(rowSel("notes.txt"));
    await page.waitForTimeout(100);
    const chip = await page.evaluate(() => {
        const row = document.querySelector('.files-row[data-path="notes.txt"]');
        const after = getComputedStyle(row, "::after");
        const doc = document.querySelector('.files-row[data-path="readme.md"]');
        return {
            ext: row.dataset.ext, content: after.content, drawn: after.content !== "none" && parseFloat(after.width) > 0,
            rightAligned: parseFloat(after.right) >= 0 && after.position === "absolute",
            // Full strength: the chip is read over dimmed words, so it must
            // not be dimmed with them.
            chipOpacity: parseFloat(after.opacity) * parseFloat(getComputedStyle(row).opacity),
            docExt: doc.dataset.ext ?? null,
        };
    });
    check("hovering a non-document shows its extension in a chip over the name's end, at full strength",
        chip.ext === "TXT" && chip.content === '"TXT"' && chip.drawn && chip.rightAligned && chip.chipOpacity === 1
            && chip.docExt === null,
        JSON.stringify(chip));
    await page.mouse.move(600, 500);
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
    // The line stands off the card's rounded edge, in the strip of page the
    // panel keeps beside it, rather than lying along the card's own edge.
    const sashOffCard = await page.evaluate(() => {
        const panel = document.querySelector(".files-panel").getBoundingClientRect();
        const card = document.querySelector(".files-card").getBoundingClientRect();
        const handle = document.querySelector(".files-panel .side-panel-resize-handle");
        const after = getComputedStyle(handle, "::after");
        const lineLeft = handle.getBoundingClientRect().right - parseFloat(after.width);
        return { cardRight: card.right, lineLeft, panelRight: panel.right, gap: lineLeft - card.right };
    });
    check("the sash's line stands off the card's rounded edge, inside the panel's box",
        sashOffCard.gap >= 3 && sashOffCard.lineLeft < sashOffCard.panelRight && sashOffCard.cardRight < sashOffCard.panelRight,
        JSON.stringify(sashOffCard));
    // The far edge again: the number the sash writes and the host is told.
    const widthBefore = await page.evaluate(() => document.querySelector(".files-panel").getBoundingClientRect().right);
    await page.mouse.down();
    await page.mouse.move(sash.x + 30, sash.y, { steps: 3 });
    await page.mouse.move(sash.x + 60, sash.y, { steps: 3 });
    const widthMid = await page.evaluate(() => ({
        panel: Math.round(document.querySelector(".files-panel").getBoundingClientRect().right),
        varPx: document.documentElement.style.getPropertyValue("--files-width"),
        posted: window.__posted.filter((m) => m.type === "fileExplorerWidth").length,
        editorMl: Math.round(parseFloat(getComputedStyle(document.querySelector("#editor")).marginLeft)),
    }));
    await page.mouse.up();
    await page.waitForTimeout(100);
    const widthAfter = await page.evaluate(() => ({
        panel: Math.round(document.querySelector(".files-panel").getBoundingClientRect().right),
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
            left: Math.round(r.left), right: Math.round(r.right), viewport: window.innerWidth,
        };
    });
    // The button is in the bar's trailing cluster and the panel docks on the
    // leading edge, so a card lined up with the button's leading edge hangs
    // off the end of the window. Both edges, because the clamp has two.
    check("the flown-out card is wholly inside the window",
        flyout.left >= 0 && flyout.right <= flyout.viewport, JSON.stringify(flyout));
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

    // ── A left TOC on the explorer's edge (?toc=left) ────────────────────
    // Wider than the runner's default: both drawers dock only where the
    // viewport holds files + toc + the TOC's 720px content column.
    const WIDE = 1400;
    await page.setViewportSize({ width: WIDE, height: 900 });
    await page.goto(`${baseUrl}/index.html?toc=left`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".files-panel", { timeout: 10000 });
    await page.waitForSelector(rowSel("readme.md"), { timeout: 10000 });
    await page.waitForTimeout(SETTLE);
    const TAB_W = 20; // --toc-tab-width
    const OPEN_PAD = 48; // #editor's left padding while a left TOC is docked open
    // revealTab.ts TAB_EDGE_INSET, measured from the DRAWER's docked corner,
    // plus the inset the drawer itself stands in by: the tab has to land on a
    // hide button that rides the panel, so it goes in with it.
    const TAB_INSET = 7 + INSET;
    const layout = () => page.evaluate(() => {
        const ed = document.querySelector("#editor");
        const cs = getComputedStyle(ed);
        const toc = document.querySelector(".toc-panel");
        const tab = document.querySelector(".toc-toggle-tab");
        const files = document.querySelector(".files-panel");
        return {
            filesOpen: document.body.classList.contains("files-open"),
            // The far edge, which is the reserve (the inset is the panel's own).
            filesWidth: Math.round(files.getBoundingClientRect().right),
            filesLeft: Math.round(files.getBoundingClientRect().left),
            tocOpen: document.body.classList.contains("toc-open"),
            tocDocked: document.body.classList.contains("toc-docked"),
            tocOverlay: document.body.classList.contains("toc-overlay"),
            tocRight: document.body.classList.contains("toc-right"),
            // The room the drawer takes, as `filesWidth` above is: its far
            // edge, less whatever the drawer it is docked beside already
            // reserved. The box is a strip narrower, because the inset each
            // drawer stands in by comes out of its own width and never out of
            // the room the content clears.
            tocWidth: Math.round(toc.getBoundingClientRect().right
                - (document.body.classList.contains("files-open")
                    ? files.getBoundingClientRect().right : 0)),
            // The drawer's own `left` (a closed drawer is translated off screen,
            // so its box says nothing) and its realized edge while open.
            tocLeft: Math.round(parseFloat(getComputedStyle(toc).left)),
            tocRectLeft: Math.round(toc.getBoundingClientRect().left),
            tabOnPage: !!tab && document.body.contains(tab),
            tabShown: !!tab && getComputedStyle(tab).display !== "none",
            tabLeft: tab ? Math.round(tab.getBoundingClientRect().left) : null,
            marginLeft: Math.round(parseFloat(cs.marginLeft)),
            marginRight: Math.round(parseFloat(cs.marginRight)),
            paddingLeft: Math.round(parseFloat(cs.paddingLeft)),
            width: Math.round(ed.getBoundingClientRect().width),
            pane: ed.parentElement.clientWidth,
        };
    });
    const breakout = () => page.evaluate(() => {
        const wrapper = document.querySelector(".ProseMirror > .code-block-wrapper");
        const before = Math.round(wrapper.getBoundingClientRect().left);
        wrapper.classList.add("bw-full");
        const left = Math.round(wrapper.getBoundingClientRect().left);
        const target = getComputedStyle(document.querySelector("#editor")).getPropertyValue("--bw-target-left").trim();
        wrapper.classList.remove("bw-full");
        return { before, left, target };
    });
    const setFixed = async (on) => {
        await page.evaluate((fixed) => {
            document.body.classList.toggle("editor-width-auto", !fixed);
            if (fixed) {
                document.documentElement.style.setProperty("--editor-max-width", "400px");
            } else {
                document.documentElement.style.removeProperty("--editor-max-width");
            }
        }, on);
        await page.waitForTimeout(SETTLE);
    };

    // Files docked open, TOC docked CLOSED on the same edge.
    const closedLeft = await layout();
    check("left profile: the explorer docks open and the TOC docks closed on the left with its tab on the page",
        closedLeft.filesOpen && closedLeft.tocDocked && !closedLeft.tocOpen && !closedLeft.tocRight
            && closedLeft.tabOnPage && closedLeft.tabShown,
        JSON.stringify(closedLeft));
    check("files open, TOC docked closed: the reveal tab sits past the explorer, at its inset from the explorer's edge",
        closedLeft.tabLeft === closedLeft.filesWidth + TAB_INSET, JSON.stringify(closedLeft));
    // Where the explorer ends, plus the drawer's own inset: both drawers
    // stand in from the edge they are docked against, and for this one that
    // edge is the explorer's far edge rather than the window's.
    check("files open, TOC docked closed: the closed drawer's left is --files-reserve plus its inset",
        closedLeft.tocLeft === closedLeft.filesWidth + INSET, JSON.stringify(closedLeft));
    const closedOffset = Math.max(0, closedLeft.filesWidth + TAB_W + GAP - LEFT_PAD);
    check("full width, TOC docked closed left: #editor's margin-left is files + tab + gap - padding, one margin for both",
        closedLeft.marginLeft === closedOffset && closedLeft.marginRight === 0
            && Math.abs(closedLeft.width - (closedLeft.pane - closedOffset)) <= 1,
        `expected ${closedOffset}, got ${JSON.stringify(closedLeft)}`);
    await setFixed(true);
    const closedFixed = await layout();
    const closedCentred = Math.max(closedLeft.filesWidth + GAP - LEFT_PAD,
        closedLeft.filesWidth + (closedFixed.pane - closedLeft.filesWidth - 400) / 2);
    check("fixed width, TOC docked closed left: #editor centres beside the explorer (the closed tab is thinner than the padding)",
        Math.abs(closedFixed.marginLeft - closedCentred) <= 1 && closedFixed.width === 400,
        `expected ${closedCentred}, got ${JSON.stringify(closedFixed)}`);
    const closedBw = await breakout();
    check("fixed width, TOC docked closed left: a bw-full block breaks out to files + tab + gap",
        closedBw.left === Math.max(LEFT_PAD, closedLeft.filesWidth + TAB_W + GAP) && closedBw.before > closedBw.left
            && closedBw.target.includes(`${closedLeft.filesWidth}px`),
        JSON.stringify(closedBw));
    await setFixed(false);

    // The tab docks the TOC open on the left: both drawers open on one edge.
    await press(".toc-toggle-tab");
    await page.waitForTimeout(SETTLE);
    const openLeft = await layout();
    check("the tab docks the TOC open on the left beside the explorer, which stays put",
        openLeft.tocOpen && openLeft.tocDocked && openLeft.filesOpen && openLeft.filesLeft === INSET, JSON.stringify(openLeft));
    // Where the explorer ends plus its own inset, and its far edge is the
    // room it takes: the two drawers leave one strip of page between them,
    // the same width as the strip each leaves at the window's frame.
    check("files open, TOC docked open: the TOC drawer starts an inset past where the explorer ends",
        openLeft.tocRectLeft === openLeft.filesWidth + INSET
            && openLeft.tocLeft === openLeft.filesWidth + INSET, JSON.stringify(openLeft));

    // The two drawers are set into the window the SAME way, which is the
    // claim worth holding rather than either one's numbers: a reader sees
    // them side by side, so a radius or an inset that moves on one and not
    // the other is the defect. Derived from the two cards rather than from
    // the constants, so a change to either sheet has to keep them equal.
    const sameShape = await page.evaluate(() => {
        const read = (sel) => {
            const el = document.querySelector(sel);
            if (!el) { return null; }
            const cs = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const panel = el.closest(".side-panel").getBoundingClientRect();
            return {
                // The whole shape rather than one corner: the cards are
                // square where they meet the chrome above and rounded below
                // it, so a single corner is "0px" on both by construction
                // and would agree whatever either sheet said about the rest.
                radius: cs.borderRadius,
                // The strip the card gives back on its sash side, which is
                // the trailing edge for both while both are docked left.
                strip: Math.round(panel.right - rect.right),
                windowTop: Math.round(panel.top),
                windowBottom: Math.round(window.innerHeight - panel.bottom),
            };
        };
        return { files: read(".files-card"), toc: read(".toc-card") };
    });
    // Each card fills its panel, so its offsets INSIDE the panel are zero for
    // both by construction and would agree whatever either sheet said; what
    // can differ, and so is what this compares, is the radius, the strip and
    // where the panels themselves stand.
    check("both drawers draw the same card: the same radius and the same strip for the sash",
        sameShape.files && sameShape.toc
            && sameShape.toc.radius === sameShape.files.radius
            && sameShape.toc.strip === sameShape.files.strip
            && sameShape.toc.strip > 0,
        JSON.stringify(sameShape));
    check("and both stand off the window's top and bottom by the same inset",
        sameShape.toc.windowBottom === sameShape.files.windowBottom
            && sameShape.toc.windowTop === sameShape.files.windowTop
            && sameShape.toc.windowBottom === INSET,
        JSON.stringify(sameShape));
    const openOffset = Math.max(0, openLeft.filesWidth + openLeft.tocWidth + GAP - OPEN_PAD);
    check("full width, both docked open left: #editor's margin-left is files + toc + gap - the open padding, width gives it up",
        openLeft.marginLeft === openOffset && openLeft.paddingLeft === OPEN_PAD && openLeft.marginRight === 0
            && Math.abs(openLeft.width - (openLeft.pane - openOffset)) <= 1,
        `expected ${openOffset}, got ${JSON.stringify(openLeft)}`);
    await setFixed(true);
    const openFixed = await layout();
    const openCentred = Math.max(openOffset,
        openLeft.filesWidth + openLeft.tocWidth + (openFixed.pane - openLeft.filesWidth - openLeft.tocWidth - 400) / 2);
    check("fixed width, both docked open left: #editor centres in the space past both drawers",
        Math.abs(openFixed.marginLeft - openCentred) <= 1 && openFixed.width === 400,
        `expected ${openCentred}, got ${JSON.stringify(openFixed)}`);
    const openBw = await breakout();
    check("fixed width, both docked open left: a bw-full block breaks out to files + toc + gap",
        openBw.left === Math.max(OPEN_PAD, openLeft.filesWidth + openLeft.tocWidth + GAP) && openBw.before > openBw.left
            && openBw.target.includes(`${openLeft.filesWidth}px`),
        JSON.stringify(openBw));

    // Files closed: every number is the TOC-only value.
    await press(".tb-files-btn");
    await page.waitForTimeout(SETTLE);
    const tocOnlyFixed = await layout();
    const tocOnlyCentred = Math.max(tocOnlyFixed.tocWidth + GAP - OPEN_PAD,
        tocOnlyFixed.tocWidth + (tocOnlyFixed.pane - tocOnlyFixed.tocWidth - 400) / 2);
    check("files closed, fixed width: the TOC drawer is back at the window's edge and #editor centres beside it alone",
        !tocOnlyFixed.filesOpen && tocOnlyFixed.tocOpen
            && tocOnlyFixed.tocRectLeft === INSET && tocOnlyFixed.tocLeft === INSET
            && Math.abs(tocOnlyFixed.marginLeft - tocOnlyCentred) <= 1,
        `expected ${tocOnlyCentred}, got ${JSON.stringify(tocOnlyFixed)}`);
    const tocOnlyBw = await breakout();
    check("files closed, fixed width: the breakout is back to toc + gap",
        tocOnlyBw.left === Math.max(OPEN_PAD, tocOnlyFixed.tocWidth + GAP) && !tocOnlyBw.target.includes(`${closedLeft.filesWidth}px`),
        JSON.stringify(tocOnlyBw));
    await setFixed(false);
    const tocOnlyFull = await layout();
    check("files closed, full width: #editor's margin-left is toc + gap - the open padding",
        tocOnlyFull.marginLeft === tocOnlyFull.tocWidth + GAP - OPEN_PAD
            && Math.abs(tocOnlyFull.width - (tocOnlyFull.pane - tocOnlyFull.marginLeft)) <= 1,
        JSON.stringify(tocOnlyFull));
    await press(".toc-hide-btn");
    await page.waitForTimeout(SETTLE);
    const bothClosed = await layout();
    check("files closed, TOC closed: the tab is back at its own inset and the margin is tab + gap - padding",
        !bothClosed.tocOpen && bothClosed.tabShown && bothClosed.tabLeft === TAB_INSET
            && bothClosed.marginLeft === Math.max(0, TAB_W + GAP - LEFT_PAD),
        JSON.stringify(bothClosed));

    // The tab follows the explorer with no TOC commit: the explorer opening,
    // and its sash being dragged, move the tab live.
    await press(".tb-files-btn");
    await page.waitForTimeout(SETTLE);
    const reopened = await layout();
    check("the explorer opening under a closed TOC moves the tab past it with no TOC commit",
        reopened.filesOpen && reopened.tabLeft === reopened.filesWidth + TAB_INSET, JSON.stringify(reopened));
    const leftSash = await page.evaluate(() => {
        const h = document.querySelector(".files-panel .side-panel-resize-handle").getBoundingClientRect();
        return { x: Math.round(h.left + h.width / 2), y: Math.round(h.top + 200) };
    });
    await page.mouse.move(leftSash.x, leftSash.y);
    await page.mouse.down();
    await page.mouse.move(leftSash.x + 40, leftSash.y, { steps: 4 });
    const midDrag = await layout();
    await page.mouse.up();
    await page.waitForTimeout(100);
    check("dragging the explorer's sash carries the tab and the margin with it, per move",
        midDrag.filesWidth === reopened.filesWidth + 40 && midDrag.tabLeft === midDrag.filesWidth + TAB_INSET
            && midDrag.marginLeft === Math.max(0, midDrag.filesWidth + TAB_W + GAP - LEFT_PAD),
        JSON.stringify({ reopened, midDrag }));

    // The TOC's docked/overlay threshold takes the explorer's reserve off the
    // viewport: at a width that holds the TOC alone but not beside the
    // explorer, the TOC floats. (The mirror is unreachable: a viewport with
    // room for the TOC beside the explorer always has room for the explorer
    // beside the TOC, since the TOC asks for the wider content column.)
    await press(".toc-toggle-tab");
    await page.waitForTimeout(SETTLE);
    const before = await layout();
    const tight = before.tocWidth + 720 + 60; // holds the TOC alone (plus slack), not files + TOC
    await page.setViewportSize({ width: tight, height: 900 });
    await page.waitForTimeout(SETTLE);
    const squeezed = await layout();
    check("a viewport with room for the TOC alone but not beside the docked explorer floats the TOC (neighborReserve)",
        before.tocDocked && before.tocOpen && before.filesOpen && tight >= before.tocWidth + 720
            && tight < before.filesWidth + before.tocWidth + 720
            && squeezed.tocOverlay && !squeezed.tocOpen && squeezed.filesOpen,
        JSON.stringify({ tight, before, squeezed }));
    await page.setViewportSize({ width: WIDE, height: 900 });
    await page.waitForTimeout(SETTLE);
    const widened = await layout();
    check("widening again docks the TOC back open beside the explorer",
        widened.tocDocked && widened.tocOpen && widened.tocRectLeft === widened.filesWidth + INSET,
        JSON.stringify(widened));
    await page.setViewportSize({ width: 1000, height: 900 });

    // ── The viewport grows without a resize event ─────────────────────────
    // A page loaded into a tab settles its mode at the size its view was
    // created at and is then given the window's, with no `resize` the shell
    // hears (sidePanel/shell.ts watches the root element's box for this).
    // Playwright's setViewportSize fires `resize` too, and it reaches the
    // shell ahead of anything this check could register, so the page is
    // loaded with `?noresize=1`, under which it keeps no `resize` listener
    // at all: the observer is then the only thing that can dock the panel.
    // Last, on its own page load, so nothing above runs under that flag.
    await page.setViewportSize({ width: 700, height: 700 });
    await page.goto(`${baseUrl}/index.html?noresize=1`);
    await page.waitForSelector(".files-panel", { state: "attached", timeout: 10000 });
    await page.waitForTimeout(SETTLE);
    const narrow = await page.evaluate(() => document.body.classList.contains("files-docked"));
    check("viewport: at a width too narrow to dock, the explorer is not docked", !narrow);
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.waitForTimeout(SETTLE);
    const grown = await page.evaluate(() => ({
        docked: document.body.classList.contains("files-docked"),
        open: document.body.classList.contains("files-open"),
        top: Math.round(document.querySelector(".files-panel").getBoundingClientRect().top),
        edge: Math.round(document.querySelector(".editor-topbar").getBoundingClientRect().bottom),
        listeners: window.__resizeListeners,
    }));
    check("viewport: the flag took, refusing the resize listeners the page tried to keep",
        grown.listeners > 0, JSON.stringify(grown));
    check("viewport: grown with no resize event heard, the explorer docks and opens on the root's own box",
        grown.docked && grown.open && grown.top === grown.edge, JSON.stringify(grown));
}
