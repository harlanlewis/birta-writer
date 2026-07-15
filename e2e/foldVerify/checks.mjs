/**
 * Unified fold grammar (MAR-110/109/111) — runtime truths against the real
 * production bundle:
 *   1. clean mount; `[!note]-` renders collapsed with the `…` chip; chip
 *      expands; gutter chevron re-collapses; old title-bar chevron is gone,
 *   2. heading fold hides its section, shows `…` at line end, and never
 *      dirties the document (zero `update` messages, byte-identical doc),
 *   3. an empty callout carries no fold affordance,
 *   4. body-class modes (fold-controls-always / -never / folding-disabled)
 *      change chevron residency; disabling expands folds and drops chrome,
 *   5. dragging a collapsed heading moves its hidden section, text conserved,
 *   6. chrome sanity: one chevron per gutter, ellipsis position on a
 *      heading-as-last-node, chip uses --vscode-editor-foldBackground.
 */
import { mkdir } from "node:fs/promises";

const SHOT_DIR = new URL("../../.e2e-shots/foldVerify/", import.meta.url).pathname;

async function shot(page, name) {
    await mkdir(SHOT_DIR, { recursive: true });
    const path = `${SHOT_DIR}${name}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log(`  screenshot: ${path}`);
    return path;
}

/** Count of posted `update` messages plus the latest serialized doc. */
function updateSnapshot(page) {
    return page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return { count: updates.length, last: updates[updates.length - 1]?.content ?? null };
    });
}

/** Rect of the first element matching `sel` whose block text includes `text`. */
function rectOf(page, sel, text) {
    return page.$$eval(sel, (els, t) => {
        const el = (t ? els.find((e) => e.textContent.includes(t)) : els[0]) ?? null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
            cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }, text ?? null);
}

/** Real hover + real click on a heading's fold chevron (identified by text). */
async function clickHeadingChevron(page, headingText) {
    // The fixture outgrew one viewport (MAR-125 coverage content): bring the
    // heading on-screen first or the hover reveal never fires.
    await page.$$eval(".ProseMirror h1, .ProseMirror h2", (els, t) => {
        els.find((e) => e.textContent.includes(t))?.scrollIntoView({ block: "center" });
    }, headingText);
    await page.waitForTimeout(100);
    const h = await rectOf(page, ".ProseMirror h1, .ProseMirror h2", headingText);
    await page.mouse.move(h.x + 40, h.cy);
    await page.waitForTimeout(150);
    const chevron = await page.$$eval(".ProseMirror .heading-fold-toggle", (els, t) => {
        const el = els.find((e) => e.closest("h1,h2,h3")?.textContent.includes(t));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2,
            opacity: parseFloat(getComputedStyle(el).opacity) };
    }, headingText);
    if (!chevron || chevron.opacity < 0.5) return null;
    await page.mouse.click(chevron.cx, chevron.cy);
    await page.waitForTimeout(120);
    return chevron;
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(700); // let init + any first serialize settle

    // Baseline update traffic BEFORE any fold interaction — fold toggles
    // must add nothing to it.
    const baseline = await updateSnapshot(page);
    await shot(page, "01-mount");

    // ── 1. `[!note]-` starts collapsed with the `…` chip ──
    const noteState = await page.evaluate(() => {
        const note = [...document.querySelectorAll(".ProseMirror .callout")]
            .find((c) => c.textContent.includes("Collapsed note"));
        if (!note) return null;
        const chip = note.querySelector(".callout-title .callout-fold-ellipsis");
        // Collapse is via visibility:hidden + height:0 + overflow:hidden on
        // the body (children keep layout so the gutter grabber survives).
        const body = note.querySelector(":scope > .callout-body");
        const bodyStyle = body ? getComputedStyle(body) : null;
        return {
            collapsed: note.classList.contains("collapsed"),
            chipVisible: chip ? getComputedStyle(chip).display !== "none" : false,
            chipBg: chip ? getComputedStyle(chip).backgroundColor : null,
            bodyHidden: bodyStyle !== null && bodyStyle.visibility === "hidden" &&
                body.clientHeight === 0 && bodyStyle.overflow === "hidden",
            oldChevron: !!note.querySelector(".callout-title .callout-fold, .callout-title .heading-fold-toggle"),
        };
    });
    check("[!note]- renders collapsed with a visible … chip",
        noteState !== null && noteState.collapsed && noteState.chipVisible && noteState.bodyHidden,
        JSON.stringify(noteState));
    check("… chip uses --vscode-editor-foldBackground",
        noteState?.chipBg === "rgba(90, 130, 200, 0.3)", `bg=${noteState?.chipBg}`);
    check("old title-bar chevron (.callout-fold) is gone", noteState?.oldChevron === false);

    // Click the chip → expands.
    const chipRect = await rectOf(page, ".ProseMirror .callout.collapsed .callout-fold-ellipsis");
    await page.mouse.click(chipRect.cx, chipRect.cy);
    await page.waitForTimeout(150);
    const expanded = await page.evaluate(() => {
        const note = [...document.querySelectorAll(".ProseMirror .callout")]
            .find((c) => c.textContent.includes("Collapsed note"));
        const body = [...note.querySelectorAll(".callout-body p")]
            .find((el) => el.textContent.includes("hidden body line"));
        return {
            collapsed: note.classList.contains("collapsed"),
            bodyVisible: body ? body.getBoundingClientRect().height > 0 : false,
        };
    });
    check("clicking … expands the callout",
        !expanded.collapsed && expanded.bodyVisible, JSON.stringify(expanded));

    // Hover the callout → gutter chevron reveals; real click re-collapses.
    const noteTitle = await rectOf(page, ".ProseMirror .callout .callout-title", "Collapsed note");
    await page.mouse.move(noteTitle.cx, noteTitle.cy);
    await page.waitForTimeout(200);
    const noteChevron = await page.evaluate(() => {
        const note = [...document.querySelectorAll(".ProseMirror .callout")]
            .find((c) => c.textContent.includes("Collapsed note"));
        const el = note?.querySelector(":scope > .callout-body > .heading-fold-gutter--foldable .heading-fold-toggle");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2,
            opacity: parseFloat(getComputedStyle(el).opacity) };
    });
    check("hovering the callout reveals its gutter chevron",
        noteChevron !== null && noteChevron.opacity > 0.5, JSON.stringify(noteChevron));
    if (noteChevron) {
        await page.mouse.click(noteChevron.cx, noteChevron.cy);
        await page.waitForTimeout(150);
    }
    const recollapsed = await page.evaluate(() => {
        const note = [...document.querySelectorAll(".ProseMirror .callout")]
            .find((c) => c.textContent.includes("Collapsed note"));
        return note.classList.contains("collapsed");
    });
    check("clicking the gutter chevron re-collapses the callout", recollapsed);
    await shot(page, "02-callout-recollapsed");

    // ── 2. Heading fold: section hides, `…` at line end, doc untouched ──
    const chev = await clickHeadingChevron(page, "Section A");
    check("hovering a heading reveals its fold chevron", chev !== null, JSON.stringify(chev));
    const sectionA = await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror > h1")]
            .find((e) => e.textContent.includes("Section A"));
        const hiddenPs = [...document.querySelectorAll(".ProseMirror > *")]
            .filter((el) => /alpha one|alpha nested|Sub A1/.test(el.textContent) && el !== h);
        const ellipsis = h.querySelector(".fold-ellipsis");
        const hr = h.getBoundingClientRect();
        const er = ellipsis?.getBoundingClientRect() ?? null;
        return {
            collapsed: h.classList.contains("heading-fold-heading--collapsed"),
            allHidden: hiddenPs.length >= 3 &&
                hiddenPs.every((el) => getComputedStyle(el).display === "none"),
            ellipsis: !!ellipsis,
            ellipsisInLine: er ? er.top >= hr.top - 2 && er.bottom <= hr.bottom + 2 : false,
            ariaLabel: ellipsis?.getAttribute("aria-label") ?? null,
        };
    });
    check("collapsing a heading hides its whole section (incl. nested H2)",
        sectionA.collapsed && sectionA.allHidden, JSON.stringify(sectionA));
    check("… chip sits on the collapsed heading's own line",
        sectionA.ellipsis && sectionA.ellipsisInLine,
        `aria=${sectionA.ariaLabel}`);
    await shot(page, "03-heading-collapsed");

    // Toggle it back and forth once more, then assert ZERO update traffic
    // since the baseline — folding never dirties the document.
    await clickHeadingChevron(page, "Section A"); // expand
    await clickHeadingChevron(page, "Section A"); // collapse again
    await clickHeadingChevron(page, "Section A"); // expand (leave open)
    await page.waitForTimeout(700); // longer than the 300ms update debounce
    const afterFolds = await updateSnapshot(page);
    check("fold/unfold posts no document updates (doc byte-identical)",
        afterFolds.count === baseline.count && afterFolds.last === baseline.last,
        `updates ${baseline.count} -> ${afterFolds.count}`);

    // ── 2b. Heading-as-last-node: collapse "Last Section" ──
    await clickHeadingChevron(page, "Last Section");
    const lastSection = await page.evaluate(() => {
        const h = [...document.querySelectorAll(".ProseMirror > h1")]
            .find((e) => e.textContent.includes("Last Section"));
        const ellipsis = h?.querySelector(".fold-ellipsis");
        if (!h || !ellipsis) return null;
        const hr = h.getBoundingClientRect();
        const er = ellipsis.getBoundingClientRect();
        const hidden = [...document.querySelectorAll(".ProseMirror > p")]
            .filter((el) => /last content/.test(el.textContent));
        return {
            collapsed: h.classList.contains("heading-fold-heading--collapsed"),
            inLine: er.top >= hr.top - 2 && er.bottom <= hr.bottom + 2,
            rightOfText: er.left > hr.left,
            hidden: hidden.length === 2 && hidden.every((el) => getComputedStyle(el).display === "none"),
        };
    });
    check("last-node heading: collapse works and … stays on the heading line",
        lastSection !== null && lastSection.collapsed && lastSection.inLine &&
        lastSection.rightOfText && lastSection.hidden,
        JSON.stringify(lastSection));
    await shot(page, "04-last-heading-collapsed");
    await clickHeadingChevron(page, "Last Section"); // expand again

    // ── 3. Empty callout: no fold affordance ──
    const emptyCallout = await page.evaluate(() => {
        const warn = [...document.querySelectorAll(".ProseMirror .callout")]
            .find((c) => c.querySelector(".callout-title")?.textContent.trim().toLowerCase().includes("warning"));
        if (!warn) return null;
        return {
            foldableGutter: !!warn.querySelector(":scope > .callout-body > .heading-fold-gutter--foldable"),
            chevron: !!warn.querySelector(".heading-fold-toggle"),
            chipVisible: (() => {
                const chip = warn.querySelector(".callout-fold-ellipsis");
                return chip ? getComputedStyle(chip).display !== "none" : false;
            })(),
        };
    });
    check("empty callout shows no fold affordance",
        emptyCallout !== null && !emptyCallout.foldableGutter && !emptyCallout.chevron &&
        !emptyCallout.chipVisible,
        JSON.stringify(emptyCallout));

    // ── 3b. Callout nested in a blockquote is foldable via its own chevron ──
    const quoted = await page.evaluate(() => {
        const q = [...document.querySelectorAll(".ProseMirror blockquote .callout")]
            .find((c) => c.textContent.includes("Quoted callout"));
        if (!q) return null;
        const toggle = q.querySelector(":scope > .callout-body > .heading-fold-gutter--foldable .heading-fold-toggle");
        return { hasToggle: !!toggle };
    });
    check("callout inside a blockquote gets its own fold chevron",
        quoted !== null && quoted.hasToggle, JSON.stringify(quoted));
    if (quoted?.hasToggle) {
        await page.$$eval(".ProseMirror blockquote .callout", (els) => {
            const q = els.find((c) => c.textContent.includes("Quoted callout"));
            q.querySelector(".heading-fold-toggle").click();
        });
        await page.waitForTimeout(150);
        const quotedFolded = await page.$$eval(".ProseMirror blockquote .callout", (els) =>
            els.find((c) => c.textContent.includes("Quoted callout"))?.classList.contains("collapsed"));
        check("quoted callout collapses via its chevron", quotedFolded === true);
        // Expand it back for later text-conservation math.
        await page.$$eval(".ProseMirror blockquote .callout", (els) => {
            const q = els.find((c) => c.textContent.includes("Quoted callout"));
            q.querySelector(".callout-fold-ellipsis").click();
        });
        await page.waitForTimeout(150);
    }

    // ── 4. Body-class visibility modes (driven via setFoldingControls, the
    //       same message the provider sends on config change) ──
    // Precondition: the note callout is collapsed (from check 1); collapse
    // Section A again so BOTH kinds of fold exist when we disable folding.
    await clickHeadingChevron(page, "Section A");

    // "always": chevrons resident without hover.
    await page.evaluate(() => window.postMessage(
        { type: "setFoldingControls", controls: "always", enabled: true }, "*"));
    await page.mouse.move(5, 5); // park the pointer away from any block
    await page.waitForTimeout(200);
    const alwaysMode = await page.evaluate(() => {
        const toggles = [...document.querySelectorAll(".milkdown .heading-fold-toggle")];
        return {
            bodyClass: document.body.className,
            count: toggles.length,
            allVisible: toggles.length > 0 && toggles.every((el) => {
                const s = getComputedStyle(el);
                return s.display !== "none" && parseFloat(s.opacity) === 1;
            }),
        };
    });
    check("fold-controls-always: every chevron resident without hover",
        alwaysMode.bodyClass.includes("fold-controls-always") && alwaysMode.allVisible,
        JSON.stringify(alwaysMode));
    await shot(page, "05-controls-always");

    // Chevron/marker overlap sanity while everything is visible.
    const overlaps = await page.evaluate(() => {
        const bad = [];
        for (const gutter of document.querySelectorAll(".milkdown .heading-fold-gutter--foldable")) {
            const toggles = gutter.querySelectorAll(".heading-fold-toggle");
            if (toggles.length !== 1) bad.push(`gutter has ${toggles.length} chevrons`);
            const t = toggles[0]?.getBoundingClientRect();
            const m = gutter.querySelector(".heading-fold-marker")?.getBoundingClientRect();
            if (t && m && t.width > 0 && m.width > 0) {
                const xOverlap = Math.min(t.right, m.right) - Math.max(t.left, m.left);
                const yOverlap = Math.min(t.bottom, m.bottom) - Math.max(t.top, m.top);
                if (xOverlap > 2 && yOverlap > 2) bad.push(`chevron overlaps marker by ${xOverlap.toFixed(1)}x${yOverlap.toFixed(1)}px`);
            }
        }
        return bad;
    });
    check("no duplicate chevrons; chevrons never overlap gutter markers",
        overlaps.length === 0, overlaps.join(" | "));

    // "never": no chevrons anywhere; existing folds keep their `…`.
    await page.evaluate(() => window.postMessage(
        { type: "setFoldingControls", controls: "never", enabled: true }, "*"));
    await page.waitForTimeout(200);
    const neverMode = await page.evaluate(() => {
        const toggles = [...document.querySelectorAll(".milkdown .heading-fold-toggle")];
        const collapsedHeading = [...document.querySelectorAll(".ProseMirror > h1")]
            .find((e) => e.textContent.includes("Section A"));
        const chip = collapsedHeading?.querySelector(".fold-ellipsis");
        return {
            bodyClass: document.body.className,
            allChevronsHidden: toggles.every((el) => getComputedStyle(el).display === "none"),
            foldKept: collapsedHeading?.classList.contains("heading-fold-heading--collapsed") ?? false,
            chipStillVisible: chip ? getComputedStyle(chip).display !== "none" : false,
        };
    });
    check("fold-controls-never: chevrons hidden, existing folds keep their …",
        neverMode.bodyClass.includes("fold-controls-never") && neverMode.allChevronsHidden &&
        neverMode.foldKept && neverMode.chipStillVisible,
        JSON.stringify(neverMode));

    // folding disabled: folds expand, zero fold chrome.
    await page.evaluate(() => window.postMessage(
        { type: "setFoldingControls", controls: "mouseover", enabled: false }, "*"));
    await page.waitForTimeout(250);
    const disabledMode = await page.evaluate(() => ({
        bodyClass: document.body.className,
        chevrons: document.querySelectorAll(".milkdown .heading-fold-toggle").length,
        hiddenBlocks: document.querySelectorAll(".milkdown .heading-fold-hidden").length,
        collapsedAnything: document.querySelectorAll(".milkdown .collapsed, .milkdown .heading-fold-heading--collapsed").length,
        headingEllipses: document.querySelectorAll(".ProseMirror h1 .fold-ellipsis, .ProseMirror h2 .fold-ellipsis").length,
        alphaVisible: [...document.querySelectorAll(".ProseMirror > p")]
            .filter((el) => /alpha/.test(el.textContent))
            .every((el) => el.getBoundingClientRect().height > 0),
        noteBodyVisible: (() => {
            const note = [...document.querySelectorAll(".ProseMirror .callout")]
                .find((c) => c.textContent.includes("Collapsed note"));
            const p = note && [...note.querySelectorAll(".callout-body p")]
                .find((el) => el.textContent.includes("hidden body line"));
            return p ? p.getBoundingClientRect().height > 0 : false;
        })(),
    }));
    check("folding-disabled: existing folds expand and zero fold chrome remains",
        disabledMode.bodyClass.includes("folding-disabled") && disabledMode.chevrons === 0 &&
        disabledMode.hiddenBlocks === 0 && disabledMode.collapsedAnything === 0 &&
        disabledMode.headingEllipses === 0 && disabledMode.alphaVisible && disabledMode.noteBodyVisible,
        JSON.stringify(disabledMode));
    await shot(page, "06-folding-disabled");

    // Disabling folding must not dirty the doc either.
    await page.waitForTimeout(500);
    const afterDisable = await updateSnapshot(page);
    check("mode switches post no document updates",
        afterDisable.count === baseline.count, `updates ${baseline.count} -> ${afterDisable.count}`);

    // Re-enable (back to default mouseover) — chrome returns, folds stay open.
    await page.evaluate(() => window.postMessage(
        { type: "setFoldingControls", controls: "mouseover", enabled: true }, "*"));
    await page.waitForTimeout(250);
    const reenabled = await page.evaluate(() => ({
        bodyClass: document.body.className,
        chevrons: document.querySelectorAll(".milkdown .heading-fold-toggle").length,
        stillExpanded: document.querySelectorAll(".milkdown .heading-fold-hidden, .milkdown .callout.collapsed").length === 0,
    }));
    check("re-enabling folding restores chevrons; folds stay expanded",
        !reenabled.bodyClass.includes("folding-disabled") && reenabled.chevrons > 0 &&
        reenabled.stillExpanded,
        JSON.stringify(reenabled));

    // ── 4b. MAR-125 coverage: nested list items, tables, code blocks ──

    // List items: only items with descendants carry a chevron (foo/bar/bing).
    const itemChevrons = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror li > .heading-fold-gutter--foldable").length);
    check("exactly the three items with descendants carry a fold chevron",
        itemChevrons === 3, `foldable item gutters: ${itemChevrons}`);

    // Real hover on foo's first line reveals its chevron; click folds.
    const fooRect = await rectOf(page, ".ProseMirror li > p", "foo");
    await page.mouse.move(fooRect.x + 10, fooRect.cy);
    await page.waitForTimeout(200);
    const fooChevron = await page.evaluate(() => {
        const li = [...document.querySelectorAll(".ProseMirror li")]
            .find((el) => el.querySelector(":scope > p")?.textContent === "foo");
        const toggle = li?.querySelector(":scope > .heading-fold-gutter--foldable .heading-fold-toggle");
        if (!toggle) return null;
        const r = toggle.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2,
            opacity: parseFloat(getComputedStyle(toggle).opacity) };
    });
    check("hovering a nested-list item reveals its fold chevron",
        fooChevron !== null && fooChevron.opacity > 0.5, JSON.stringify(fooChevron));
    if (fooChevron) {
        await page.mouse.click(fooChevron.cx, fooChevron.cy);
        await page.waitForTimeout(150);
    }
    const listFold = await page.evaluate(() => {
        const items = [...document.querySelectorAll(".ProseMirror li")];
        // startsWith, not ===: a collapsed item's first line carries the
        // `…` chip widget inside the <p>, so its textContent is "foo…".
        const byLine = (t) => items.find((el) =>
            el.querySelector(":scope > p")?.textContent.startsWith(t));
        const foo = byLine("foo");
        const hidden = (t) => {
            const el = byLine(t);
            return el ? el.getBoundingClientRect().height === 0 : false;
        };
        const chip = foo?.querySelector(":scope > p .fold-ellipsis");
        return {
            collapsed: foo?.classList.contains("collapsed") ?? false,
            barHidden: hidden("bar"), bazHidden: hidden("baz"), zapHidden: hidden("zap"),
            bingVisible: !hidden("bing"), dingVisible: !hidden("ding"),
            fooLineVisible: (foo?.querySelector(":scope > p")?.getBoundingClientRect().height ?? 0) > 0,
            chipVisible: chip ? getComputedStyle(chip).display !== "none" : false,
        };
    });
    check("folding foo hides bar/baz/zap; bing/ding and foo's own line stay visible",
        listFold.collapsed && listFold.barHidden && listFold.bazHidden && listFold.zapHidden &&
        listFold.bingVisible && listFold.dingVisible && listFold.fooLineVisible && listFold.chipVisible,
        JSON.stringify(listFold));
    await shot(page, "06b-list-item-folded");
    // Chip click expands again.
    await page.evaluate(() => {
        [...document.querySelectorAll(".ProseMirror li.collapsed .fold-ellipsis")][0]?.click();
    });
    await page.waitForTimeout(150);
    const listExpanded = await page.evaluate(() => ({
        collapsed: document.querySelectorAll(".ProseMirror li.collapsed").length,
        barVisible: [...document.querySelectorAll(".ProseMirror li")]
            .find((el) => el.querySelector(":scope > p")?.textContent === "bar")
            ?.getBoundingClientRect().height > 0,
    }));
    check("clicking the item's … chip expands the subtree",
        listExpanded.collapsed === 0 && listExpanded.barVisible, JSON.stringify(listExpanded));

    // Table: chevron folds to the header row; overlay chrome hides; chip
    // expands. (Programmatic toggle click — the quoted-callout precedent.)
    const tableFold = await page.evaluate(() => {
        const wrap = document.querySelector(".ProseMirror .mw-table");
        const toggle = wrap?.querySelector(".heading-fold-toggle");
        if (!toggle) return null;
        toggle.click();
        return true;
    });
    check("the table gutter carries a fold chevron", tableFold === true);
    await page.waitForTimeout(150);
    const tableState = await page.evaluate(() => {
        const wrap = document.querySelector(".ProseMirror .mw-table");
        const rows = [...wrap.querySelectorAll("tbody > tr")];
        const overlay = wrap.querySelector(".mw-table-overlay");
        const chip = wrap.querySelector(".mw-table-fold-ellipsis");
        return {
            collapsed: wrap.classList.contains("collapsed"),
            headerVisible: rows[0].getBoundingClientRect().height > 0,
            bodyHidden: rows.slice(1).every((r) => getComputedStyle(r).display === "none"),
            overlayHidden: getComputedStyle(overlay).display === "none",
            chipVisible: chip ? getComputedStyle(chip).display !== "none" : false,
        };
    });
    check("folding a table keeps the header row and hides body rows + overlay chrome",
        tableState.collapsed && tableState.headerVisible && tableState.bodyHidden &&
        tableState.overlayHidden && tableState.chipVisible,
        JSON.stringify(tableState));
    // Visual grammar: the chip sits ON the header row's line, just past its
    // right edge — never in block flow below the table (where it read as
    // chrome of the NEXT block).
    const tableChipGeom = await page.evaluate(() => {
        const wrap = document.querySelector(".ProseMirror .mw-table");
        const header = wrap.querySelector("tbody > tr").getBoundingClientRect();
        const chip = wrap.querySelector(".mw-table-fold-ellipsis").getBoundingClientRect();
        const chipMid = chip.top + chip.height / 2;
        return {
            onHeaderLine: chipMid > header.top && chipMid < header.bottom,
            pastRightEdge: chip.left >= header.right,
        };
    });
    check("the table's … chip sits on the header line, past its right edge",
        tableChipGeom.onHeaderLine && tableChipGeom.pastRightEdge,
        JSON.stringify(tableChipGeom));
    await shot(page, "06c-table-folded");
    await page.evaluate(() =>
        document.querySelector(".ProseMirror .mw-table .mw-table-fold-ellipsis")?.click());
    await page.waitForTimeout(150);
    const tableExpanded = await page.evaluate(() => {
        const wrap = document.querySelector(".ProseMirror .mw-table");
        const rows = [...wrap.querySelectorAll("tbody > tr")];
        return {
            collapsed: wrap.classList.contains("collapsed"),
            allRowsVisible: rows.every((r) => r.getBoundingClientRect().height > 0),
            overlayBack: getComputedStyle(wrap.querySelector(".mw-table-overlay")).display !== "none",
            chipHidden: getComputedStyle(wrap.querySelector(".mw-table-fold-ellipsis")).display === "none",
        };
    });
    check("the table's … chip expands body rows and restores the overlay",
        !tableExpanded.collapsed && tableExpanded.allRowsVisible && tableExpanded.overlayBack &&
        tableExpanded.chipHidden,
        JSON.stringify(tableExpanded));

    // Code block: chevron folds to the chrome row (lang picker stays); chip
    // sits in the header; content area hides.
    const codeFold = await page.evaluate(() => {
        const wrap = [...document.querySelectorAll(".ProseMirror .code-block-wrapper")]
            .find((el) => el.textContent.includes("const one"));
        const toggle = wrap?.querySelector(".heading-fold-toggle");
        if (!toggle) return null;
        toggle.click();
        return true;
    });
    check("the code-block gutter carries a fold chevron", codeFold === true);
    await page.waitForTimeout(150);
    const codeState = await page.evaluate(() => {
        const wrap = [...document.querySelectorAll(".ProseMirror .code-block-wrapper")]
            .find((el) => el.classList.contains("collapsed"));
        if (!wrap) return null;
        const pre = wrap.querySelector(":scope > pre");
        const header = wrap.querySelector(".code-block-header");
        const chip = header?.querySelector(".code-fold-ellipsis");
        const preStyle = getComputedStyle(pre);
        return {
            headerVisible: header.getBoundingClientRect().height > 0,
            langPickerVisible: header.querySelector(".lang-picker-btn").getBoundingClientRect().height > 0,
            preHidden: preStyle.visibility === "hidden" && pre.clientHeight === 0,
            chipVisible: chip ? getComputedStyle(chip).display !== "none" : false,
        };
    });
    check("folding a code block keeps the chrome row and hides the content area",
        codeState !== null && codeState.headerVisible && codeState.langPickerVisible &&
        codeState.preHidden && codeState.chipVisible,
        JSON.stringify(codeState));
    await shot(page, "06d-code-folded");
    await page.evaluate(() =>
        document.querySelector(".ProseMirror .code-block-wrapper.collapsed .code-fold-ellipsis")?.click());
    await page.waitForTimeout(150);
    const codeExpanded = await page.evaluate(() => {
        const wrap = [...document.querySelectorAll(".ProseMirror .code-block-wrapper")]
            .find((el) => el.textContent.includes("const one"));
        return {
            collapsed: wrap.classList.contains("collapsed"),
            preVisible: wrap.querySelector(":scope > pre").clientHeight > 0,
            chipHidden: getComputedStyle(wrap.querySelector(".code-fold-ellipsis")).display === "none",
        };
    });
    check("the code block's … chip restores the content area",
        !codeExpanded.collapsed && codeExpanded.preVisible && codeExpanded.chipHidden,
        JSON.stringify(codeExpanded));

    // None of the MAR-125 folds may have dirtied the document.
    await page.waitForTimeout(700);
    const afterCoverage = await updateSnapshot(page);
    check("list/table/code folds post no document updates",
        afterCoverage.count === baseline.count, `updates ${baseline.count} -> ${afterCoverage.count}`);

    // ── 5. Drag a COLLAPSED heading: hidden section travels, text conserved ──
    const preDrag = await updateSnapshot(page);
    const preDoc = preDrag.last; // may be null if nothing ever serialized
    await clickHeadingChevron(page, "Section A"); // collapse A
    // Hover Section A's heading, grab its gutter marker (the H1 badge).
    const hA = await rectOf(page, ".ProseMirror > h1", "Section A");
    await page.mouse.move(hA.x + 40, hA.cy);
    await page.waitForTimeout(150);
    const marker = await page.$$eval(".ProseMirror > h1 .heading-fold-marker", (els) => {
        const el = els.find((e) => e.closest("h1")?.textContent.includes("Section A"));
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    });
    // Drop below "beta content" (end of Section B's body).
    const beta = await rectOf(page, ".ProseMirror > p", "beta content");
    await page.mouse.move(marker.cx, marker.cy);
    await page.mouse.down();
    await page.mouse.move(marker.cx + 10, marker.cy + 10);
    await page.mouse.move(beta.cx, beta.y + beta.h - 2, { steps: 10 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(700); // update debounce
    const postDrag = await updateSnapshot(page);
    const doc = postDrag.last;
    const dragChecks = doc === null ? null : (() => {
        const iB = doc.indexOf("# Section B");
        const iBeta = doc.indexOf("beta content");
        const iA = doc.indexOf("# Section A");
        const iAlpha = doc.indexOf("alpha one");
        const iSub = doc.indexOf("## Sub A1");
        const iNested = doc.indexOf("alpha nested");
        const once = (s) => doc.indexOf(s) === doc.lastIndexOf(s) && doc.indexOf(s) !== -1;
        return {
            moved: iB !== -1 && iB < iA && iBeta < iA,
            sectionIntact: iA < iAlpha && iAlpha < iSub && iSub < iNested,
            eachOnce: ["# Section A", "alpha one", "## Sub A1", "alpha nested",
                "# Section B", "beta content"].every(once),
        };
    })();
    check("dragging a collapsed heading moves its hidden section with it",
        dragChecks !== null && dragChecks.moved && dragChecks.sectionIntact && dragChecks.eachOnce,
        JSON.stringify(dragChecks));
    // Full text conservation: every fixture snippet survives the move (and
    // exactly-once for the section lines, asserted above). When an earlier
    // serialization exists, also require a line-multiset match against it.
    const norm = (d) => d.split("\n").map((l) => l.trim()).filter(Boolean).sort().join("\n");
    const snippetsConserved = doc !== null && [
        "# Section A", "alpha one", "## Sub A1", "alpha nested",
        "# Section B", "beta content", "Collapsed note", "hidden body line",
        "second hidden line", "Open tip", "tip first block", "tip second block",
        "quote intro", "Quoted callout", "quoted callout body",
        "list item one", "list item two",
        "foo", "bar", "baz", "zap", "bing", "ding",
        "a1", "d1", "const one = 1;", "const two = 2;",
        "# Last Section", "last content one", "last content two",
    ].every((s) => doc.includes(s));
    check("document text is conserved across the fold+drag",
        snippetsConserved && (preDoc === null || norm(doc) === norm(preDoc)),
        doc === null ? "no update posted" : "");
    // The fold state travelled: Section A still collapsed after the move.
    const stillCollapsed = await page.$$eval(".ProseMirror > h1", (els) => {
        const h = els.find((e) => e.textContent.includes("Section A"));
        return {
            collapsed: h?.classList.contains("heading-fold-heading--collapsed") ?? false,
            hidden: [...document.querySelectorAll(".ProseMirror > *")]
                .filter((el) => /alpha one|alpha nested/.test(el.textContent) && el.tagName !== "H1")
                .every((el) => getComputedStyle(el).display === "none"),
        };
    });
    check("the moved heading is still collapsed (fold entry travelled)",
        stillCollapsed.collapsed && stillCollapsed.hidden, JSON.stringify(stillCollapsed));
    await shot(page, "07-after-collapsed-drag");

    // ── 6. Drop at a collapsed section's end REVEALS it (MAR-146) ──
    // The end-of-document slot sits inside a collapsed LAST section: fold
    // extents derive from heading ranks, so a section nothing terminates owns
    // every later boundary. The slot is visible and aimable (the drag UI
    // offers it), so the drop is honored by opening the fold — before the fix
    // the block silently landed at display:none and read as deleted.
    await clickHeadingChevron(page, "Last Section");
    const hiddenUnderLast = await page.$$eval(".ProseMirror > *", (els) =>
        els.filter((el) => /last content one|last content two/.test(el.textContent)
                && el.tagName !== "H1")
            .every((el) => getComputedStyle(el).display === "none"));
    check("precondition: the last section is collapsed and its body hidden", hiddenUnderLast);

    // Grab a visible TOP-LEVEL paragraph (only those carry a block gutter
    // marker) and drop it past the bottom of the document.
    const dragged = "beta content";
    const src = await rectOf(page, ".ProseMirror > p", dragged);
    await page.mouse.move(src.x + 40, src.cy);
    await page.waitForTimeout(150);
    const pMarker = await page.$$eval(".heading-fold-marker--paragraph", (els, t) => {
        const el = els.find((e) => e.closest("p")?.textContent.includes(t));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    }, dragged);
    let revealChecks = { grabbed: pMarker !== null };
    if (pMarker) {
        const lastBlock = await page.evaluate(() => {
            const els = [...document.querySelectorAll(".ProseMirror > *")]
                .filter((el) => getComputedStyle(el).display !== "none");
            const r = els[els.length - 1].getBoundingClientRect();
            return { cx: r.x + r.width / 2, bottom: r.bottom };
        });
        await page.mouse.move(pMarker.cx, pMarker.cy);
        await page.mouse.down();
        await page.mouse.move(pMarker.cx + 10, pMarker.cy + 10);
        await page.mouse.move(lastBlock.cx, lastBlock.bottom - 1, { steps: 10 });
        await page.waitForTimeout(120);
        revealChecks.indicatorShown = await page.$eval(".block-drag-indicator", (el) =>
            getComputedStyle(el).display !== "none");
        await page.mouse.up();
        await page.waitForTimeout(700);
        Object.assign(revealChecks, await page.$$eval(".ProseMirror > *", (els, t) => {
            const visible = (el) => getComputedStyle(el).display !== "none";
            const landed = els.find((el) => el.textContent.includes(t) && el.tagName === "P");
            const head = els.find((el) => el.textContent.includes("Last Section")
                && el.tagName === "H1");
            return {
                // The dragged block is where the user put it — and can see it.
                landingVisible: landed ? visible(landed) : false,
                // The fold that would have swallowed it is open.
                revealed: head ? !head.classList.contains("heading-fold-heading--collapsed") : false,
                bodyVisible: els.filter((el) => /last content one|last content two/
                    .test(el.textContent) && el.tagName !== "H1").every(visible),
            };
        }, dragged));
    }
    check("dropping at a collapsed last section's end reveals it instead of hiding the landing",
        revealChecks.grabbed && revealChecks.indicatorShown && revealChecks.landingVisible
            && revealChecks.revealed && revealChecks.bodyVisible,
        JSON.stringify(revealChecks));
    await shot(page, "08-reveal-on-drop");
}
