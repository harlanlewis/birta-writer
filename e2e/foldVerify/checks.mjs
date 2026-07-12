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
}
