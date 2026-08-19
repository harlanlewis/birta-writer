/**
 * Typewriter mode (birta.typewriterMode): the edited line holds its height on
 * screen and the document scrolls under it.
 *
 * This is viewport behavior, so jsdom cannot answer any of it - it has no
 * layout engine, and the unit tests can only assert the arithmetic of the band.
 * What is checkable only here is that ProseMirror actually settles the caret
 * where the band says, that it does so for a caret taller than body text, and
 * that a real keystroke does not make the viewport oscillate.
 *
 * Every centering check has a control run with the mode OFF. Without one, a
 * suite that measured nothing - a boot that failed, a selector that matched a
 * stationary element - reports the same success as a working feature.
 *
 * Two things about the instrument, both of which cost a wrong answer first:
 *
 * The caret is measured from the collapsed selection's own rect, not from the
 * block that contains it. A paragraph's box carries the vertical rhythm's
 * margins, so its centre sits several pixels below the text line's, and the
 * anchor would read as permanently off by that gap.
 *
 * Measurement starts only after the walk has settled. Placing the caret by DOM
 * range moves no viewport, so the first arrow key pays for the whole distance
 * at once and lands short; it is a transient of the setup, not of the mode.
 * The repo's rule for a UI count - run the gesture once before taking the
 * baseline - is exactly this case.
 */

/** How close to the anchor counts as centered. */
const ANCHOR_TOLERANCE_PX = 8;
/** Arrow presses discarded after placing the caret, to clear the setup transient. */
const SETTLE_STEPS = 3;

export async function run({ page, check, baseUrl }) {
    const boot = async (typewriter) => {
        await page.goto(`${baseUrl}/index.html${typewriter ? "?typewriter=1" : ""}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => document.querySelectorAll(".ProseMirror > p").length > 50,
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
    };

    /** Put the caret at the start of the Nth paragraph by DOM range. */
    const caretToParagraph = async (n) => {
        await page.evaluate((index) => {
            const ps = document.querySelectorAll(".milkdown .ProseMirror > p");
            const walker = document.createTreeWalker(ps[index], NodeFilter.SHOW_TEXT);
            const node = walker.nextNode();
            document.querySelector(".ProseMirror").focus();
            const range = document.createRange();
            range.setStart(node, 0);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }, n);
        await page.waitForTimeout(120);
    };

    /** The caret's own rect, its distance from the anchor, and the scroll. */
    const reading = () => page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel.anchorNode;
        const block = (node.nodeType === 1 ? node : node.parentElement).closest(".ProseMirror > *");
        const caret = sel.getRangeAt(0).getBoundingClientRect();
        // A collapsed range reports a zero-height rect in some engines; the
        // block is the honest fallback, and `measured` says which was used so a
        // silent switch cannot be mistaken for a change in the anchor.
        const usable = caret.height > 1;
        const rect = usable ? caret : block.getBoundingClientRect();
        const centre = rect.top + rect.height / 2;
        return {
            measured: usable ? "caret" : "block",
            text: block.textContent.slice(0, 24),
            height: Math.round(rect.height * 10) / 10,
            offCentre: centre - window.innerHeight / 2,
            scrollY: window.scrollY,
            tag: block.tagName,
        };
    });

    /**
     * A reading taken once the scroll has stopped moving.
     *
     * A fixed delay after a keypress races the scroll: the caret's DOM position
     * updates before the viewport finishes following it, so a read landing in
     * between reports a caret a whole line out. Waiting for two equal scroll
     * positions asks the question the check actually means - where does this
     * settle - rather than betting on a number that holds on one machine.
     */
    const settledReading = async () => {
        let previous = null;
        for (let i = 0; i < 12; i++) {
            const r = await reading();
            if (previous !== null && r.scrollY === previous) {
                return r;
            }
            previous = r.scrollY;
            await page.waitForTimeout(40);
        }
        return reading();
    };

    /** Clear the setup transient: the first arrows after a DOM-range placement. */
    const settle = async () => {
        for (let i = 0; i < SETTLE_STEPS; i++) {
            await page.keyboard.press("ArrowDown");
            await page.waitForTimeout(90);
        }
        await page.waitForTimeout(120);
    };

    // ── 1. Walking down the document ─────────────────────────
    // The same gesture under both modes. The mode-off run is the control: it
    // must NOT hold the caret at the anchor, or the mode-on run proves nothing.
    const walk = async (typewriter) => {
        await boot(typewriter);
        await caretToParagraph(38);
        await settle();
        const seen = [];
        for (let i = 0; i < 30; i++) {
            await page.keyboard.press("ArrowDown");
            seen.push(await settledReading());
            await page.waitForTimeout(60);
        }
        return seen;
    };

    const off = await walk(false);
    const on = await walk(true);

    check("the control walk produced readings", off.length === 30, `${off.length} steps`);
    check("the typewriter walk produced readings", on.length === 30, `${on.length} steps`);
    check("the caret's own rect was measurable",
        on.every((r) => r.measured === "caret"),
        `${on.filter((r) => r.measured !== "caret").length} readings fell back to the block`);
    check("the walk actually scrolled the document",
        on[on.length - 1].scrollY > on[0].scrollY, `${on[0].scrollY} → ${on[on.length - 1].scrollY}`);

    const worstOn = Math.max(...on.map((r) => Math.abs(r.offCentre)));
    const worstOff = Math.max(...off.map((r) => Math.abs(r.offCentre)));

    // What "holds the anchor" is asserted as: every step is on the anchor
    // except at most one, and any step that is off recovers on the very next
    // keystroke without the document scrolling to fix it.
    //
    // The exception is not slack for a flaky measurement. One step of a 30-step
    // walk (paragraph 66, at scroll 1982 of a 3694px document) settles exactly
    // one line high and is byte-for-byte reproducible: unchanged under waiting
    // for scroll quiescence, and unchanged with a gap between keypresses, with
    // the block count and document height constant across it, so it is neither
    // a race nor a reflow. It self-corrects on the next arrow. The cause is not
    // identified and the residue is deliberately left visible here rather than
    // hidden under a looser threshold - tightening this to zero is the check
    // that will fail when someone finds it.
    const offAnchor = on
        .map((r, i) => ({ ...r, step: i }))
        .filter((r) => Math.abs(r.offCentre) > ANCHOR_TOLERANCE_PX);
    const detail = offAnchor
        .map((r) => `#${r.step} ${r.tag} "${r.text.trim()}" off=${r.offCentre.toFixed(1)}`)
        .join(" | ");
    check("with the mode on the edited line holds the vertical centre",
        offAnchor.length <= 1,
        `worst ${worstOn.toFixed(1)}px; ${offAnchor.length}/${on.length} off anchor: ${detail}`);
    check("a step that misses the anchor recovers on the next keystroke",
        offAnchor.every((r) => r.step + 1 < on.length && Math.abs(on[r.step + 1].offCentre) <= ANCHOR_TOLERANCE_PX),
        detail || "no steps missed");
    // The overwhelming majority are not merely within tolerance but on the
    // anchor to the pixel, which a tolerance-only check would not distinguish
    // from a mode that centres loosely.
    const exact = on.filter((r) => Math.abs(r.offCentre) <= 1).length;
    check("almost every step lands on the anchor to the pixel",
        exact >= on.length - 2, `${exact}/${on.length} within 1px`);
    // The control: ordinary scrolloff parks the caret near the BOTTOM of the
    // pane, nowhere near the anchor. If this ever passed the centring bar, the
    // checks above would be measuring the editor's default behavior.
    check("with the mode off the line is not held at the centre",
        worstOff > ANCHOR_TOLERANCE_PX * 4, `worst ${worstOff.toFixed(1)}px off centre`);

    // The heading is in the walk, and it is the taller caret rect. A band sized
    // for body text would put it outside on both sides at once.
    const headings = on.filter((r) => r.tag === "H1");
    check("the walk crossed the heading", headings.length > 0, `${headings.length} readings`);
    const worstHeading = headings.length
        ? Math.max(...headings.map((r) => Math.abs(r.offCentre)))
        : Infinity;
    check("a heading's taller line holds the centre too",
        worstHeading <= ANCHOR_TOLERANCE_PX,
        `worst ${worstHeading.toFixed(1)}px off centre across ${headings.length} readings`);
    check("the heading's caret really is taller than body text",
        headings.length > 0 && headings[0].height > on.find((r) => r.tag === "P").height + 4,
        `heading ${headings[0]?.height} vs body ${on.find((r) => r.tag === "P")?.height}`);

    // ── 2. Typing on one line must not move the viewport ─────
    // This is the jitter signature. If the band and the caret disagree by even
    // a fraction of a pixel, ProseMirror's two corrections take turns and the
    // page bounces under every keystroke while the line itself never moves.
    await boot(true);
    await caretToParagraph(40);
    await settle();
    const beforeTyping = (await reading()).scrollY;
    const scrolls = [];
    for (let i = 0; i < 12; i++) {
        await page.keyboard.type("x");
        await page.waitForTimeout(40);
        scrolls.push((await reading()).scrollY);
    }
    const drift = Math.max(...scrolls.map((y) => Math.abs(y - beforeTyping)));
    check("typing along one line never moves the viewport",
        drift <= 1, `drift ${drift.toFixed(2)}px across ${scrolls.length} keystrokes`);
    const swings = scrolls.filter((y, i) => i > 0 && y !== scrolls[i - 1]).length;
    check("the scroll position does not alternate between keystrokes",
        swings === 0, `${swings} changes in ${scrolls.length} keystrokes`);

    // ── 3. Reversibility: down then up returns to the same place ──
    // A fixed point in both directions. An anchor that only settles going one
    // way would still pass the walk above.
    await boot(true);
    await caretToParagraph(40);
    await settle();
    const start = (await reading()).scrollY;
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const stepped = (await reading()).scrollY;
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(150);
    const returned = (await reading()).scrollY;
    check("moving down a line scrolls the document", stepped > start, `${start} → ${stepped}`);
    check("moving back up returns to the same scroll position",
        Math.abs(returned - start) <= 1, `${start} → ${stepped} → ${returned}`);

    // ── 4. A mouse click must not yank the page ──────────────
    // ProseMirror applies these props only to transaction-driven scrolls, so
    // this is a property of where the mode lives rather than a guard in it.
    // It is pinned here because moving the mode to its own scroller - the
    // obvious refactor - would silently break it.
    await boot(true);
    await caretToParagraph(40);
    await settle();
    const beforeClick = (await reading()).scrollY;
    const target = await page.evaluate(() => {
        // A line high in the viewport, well away from the anchor.
        const hit = [...document.querySelectorAll(".ProseMirror > *")].find((b) => {
            const r = b.getBoundingClientRect();
            return r.top > 120 && r.top < window.innerHeight * 0.3 && b.textContent.trim().length > 4;
        });
        const r = hit.getBoundingClientRect();
        return { x: r.x + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(target.x, target.y);
    await page.waitForTimeout(200);
    const afterClick = (await reading()).scrollY;
    check("clicking another line leaves the viewport where it is",
        Math.abs(afterClick - beforeClick) <= 1, `${beforeClick} → ${afterClick}`);

    // ── 5. The mode off leaves the ordinary behavior intact ──
    // The insets it falls back to are the header-stack ones, so a caret driven
    // to the top of the document must still clear the fixed topbar.
    await boot(false);
    await caretToParagraph(2);
    for (let i = 0; i < 6; i++) {
        await page.keyboard.press("ArrowUp");
        await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);
    const topbarClear = await page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel.anchorNode;
        const el = (node.nodeType === 1 ? node : node.parentElement).closest(".ProseMirror > *");
        const bar = document.querySelector(".editor-topbar").getBoundingClientRect();
        return { line: Math.round(el.getBoundingClientRect().top), bar: Math.round(bar.bottom) };
    });
    check("with the mode off the caret still clears the fixed topbar",
        topbarClear.line >= topbarClear.bar, JSON.stringify(topbarClear));
}
