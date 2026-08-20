/**
 * The `/date` calendar, driven with real keys through a real editor.
 *
 * Run under BOTH engines. The keyboard arms are the reason this suite exists
 * rather than a jsdom test: a prop-level check cannot see which listener wins,
 * and the specific defect class in play is WebKit's, where a `contenteditable`
 * that has been blurred by a focus-taking popup does not reliably hold its
 * selection when it is focused again. The picker is the first surface in this
 * editor that takes real focus off the document and gives it back, so the
 * "type after closing" arms below are the whole point.
 *   node e2e/run.mjs datePicker
 *   BIRTA_E2E_BROWSER=webkit node e2e/run.mjs datePicker
 */

export async function run({ page, check, baseUrl }) {
    async function mount() {
        await page.goto(`${baseUrl}/index.html`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /Second line/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
    }

    /** The most recent serialized document the webview posted out. */
    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    /** Puts the caret at the end of the paragraph with the given text. */
    async function caretAtEndOf(text) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const p = page.locator(`.milkdown .ProseMirror p:text-is("${text}")`).first();
            await p.click();
            await page.keyboard.press("End");
            await page.waitForTimeout(150);
            const ok = await page.evaluate((t) => {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) { return false; }
                const node = sel.anchorNode;
                const block = node?.nodeType === 3 ? node.parentElement : node;
                return (block?.closest("p")?.textContent ?? "") === t;
            }, text);
            if (ok) { return true; }
            await page.waitForTimeout(250);
        }
        return false;
    }

    /** Types `/date` and waits for the calendar. */
    async function openPicker() {
        // The slash trigger only arms after whitespace or at a block start, so
        // the probe types the separating space the user would type anyway.
        await page.keyboard.type(" /date", { delay: 40 });
        await page.waitForTimeout(250);
        await page.keyboard.press("Enter");
        await page.waitForSelector(".date-picker", { timeout: 5000 });
        await page.waitForTimeout(200);
    }

    // ── 1. The picker opens, and is the shape the pattern requires ──────────
    await mount();
    check("the probe placed the caret in the first paragraph", await caretAtEndOf("First line."), "");
    await openPicker();

    const aria = await page.evaluate(() => {
        const root = document.querySelector(".date-picker");
        const grid = root?.querySelector('[role="grid"]');
        const cells = [...(grid?.querySelectorAll('[role="gridcell"]') ?? [])];
        const heads = [...(grid?.querySelectorAll('[role="columnheader"]') ?? [])];
        return {
            dialog: root?.getAttribute("role"),
            modal: root?.getAttribute("aria-modal"),
            labelled: !!root?.getAttribute("aria-label"),
            gridLabelled: !!grid?.getAttribute("aria-labelledby")
                && !!document.getElementById(grid.getAttribute("aria-labelledby")),
            cellCount: cells.length,
            headCount: heads.length,
            // The question is whether the SPOKEN name is fuller than the drawn
            // one, not how many characters it has: a CJK weekday name is three
            // characters long and perfectly correct.
            headsHaveAbbr: heads.every((h) => {
                const abbr = h.getAttribute("abbr") ?? "";
                return abbr.length > 0 && abbr.length >= (h.textContent ?? "").length;
            }),
            headsAbbrDiffers: heads.some((h) => h.getAttribute("abbr") !== h.textContent),
            tabbable: cells.filter((c) => c.getAttribute("tabindex") === "0").length,
            selected: cells.filter((c) => c.getAttribute("aria-selected") === "true").length,
            current: cells.filter((c) => c.getAttribute("aria-current") === "date").length,
            liveRegion: !!root?.querySelector('[aria-live="polite"]'),
            cellsNamed: cells.every((c) => (c.getAttribute("aria-label") ?? "").length > 6),
        };
    });

    check("the picker is a labelled modal dialog", aria.dialog === "dialog" && aria.modal === "true" && aria.labelled, JSON.stringify(aria));
    check("the calendar is a grid named by its month heading", aria.gridLabelled, String(aria.gridLabelled));
    check("the grid is six rows of seven day cells", aria.cellCount === 42, String(aria.cellCount));
    check("there are seven column headers, each with a full weekday name",
        aria.headCount === 7 && aria.headsHaveAbbr, JSON.stringify([aria.headCount, aria.headsHaveAbbr]));
    // Without this the arm above passes on a build that set `abbr` to the same
    // two letters the column already shows, which buys a reader nothing.
    check("the spoken weekday name is not just the drawn abbreviation",
        aria.headsAbbrDiffers, String(aria.headsAbbrDiffers));
    check("exactly one cell is in the tab sequence (roving tabindex)", aria.tabbable === 1, String(aria.tabbable));
    check("exactly one cell is aria-selected", aria.selected === 1, String(aria.selected));
    check("exactly one cell is aria-current=date", aria.current === 1, String(aria.current));
    check("the month heading is a polite live region", aria.liveRegion, String(aria.liveRegion));
    check("every day cell has a spoken full-date name", aria.cellsNamed, String(aria.cellsNamed));

    const focusedIsCell = await page.evaluate(() =>
        document.activeElement?.getAttribute("role") === "gridcell");
    check("focus moved into the grid when it opened", focusedIsCell, String(focusedIsCell));

    // ── 2. Arrow keys move by a day, and the roving tabindex follows ────────
    const before = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(120);
    const afterRight = await page.evaluate(() => ({
        label: document.activeElement?.getAttribute("aria-label"),
        role: document.activeElement?.getAttribute("role"),
        tabbable: [...document.querySelectorAll('[role="gridcell"]')]
            .filter((c) => c.getAttribute("tabindex") === "0").length,
        selected: [...document.querySelectorAll('[role="gridcell"]')]
            .filter((c) => c.getAttribute("aria-selected") === "true").length,
    }));
    check("ArrowRight moves the focused day", afterRight.label !== before && afterRight.role === "gridcell", `${before} -> ${afterRight.label}`);
    check("the roving tabindex still names exactly one cell after moving", afterRight.tabbable === 1 && afterRight.selected === 1, JSON.stringify(afterRight));

    // ArrowDown is a week, so Right then Down then six Lefts returns to the
    // start. A grid that moved by the wrong stride fails to come back.
    await page.keyboard.press("ArrowDown");
    for (let i = 0; i < 8; i++) { await page.keyboard.press("ArrowLeft"); }
    await page.waitForTimeout(150);
    const roundTrip = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    check("ArrowDown is exactly seven days, so a right-down-eight-left loop returns", roundTrip === before, `${before} vs ${roundTrip}`);

    // ── 3. PageUp changes the month, and the heading announces it ───────────
    const monthBefore = await page.evaluate(() => document.querySelector(".date-picker__month")?.textContent);
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(150);
    const monthAfter = await page.evaluate(() => document.querySelector(".date-picker__month")?.textContent);
    check("PageUp moves to the previous month", monthAfter !== monthBefore && !!monthAfter, `${monthBefore} -> ${monthAfter}`);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(150);
    const monthBack = await page.evaluate(() => document.querySelector(".date-picker__month")?.textContent);
    check("PageDown returns to the month it came from", monthBack === monthBefore, `${monthBack} vs ${monthBefore}`);

    // ── 3b. A month stepper keeps its own focus, so Enter never falls through ─
    // Enter on a button fires its click. If activating a stepper also moved
    // focus into the grid, the NEXT Enter would land on a day cell and insert a
    // date, so a keyboard user paging two months forward would write one by
    // accident. The APG pattern keeps focus on the button for exactly this.
    await page.keyboard.press("Tab");
    const tabbedTo = await page.evaluate(() => ({
        role: document.activeElement?.getAttribute("role"),
        label: document.activeElement?.getAttribute("aria-label"),
        inPicker: !!document.activeElement?.closest(".date-picker"),
    }));
    check("Tab moves within the picker rather than out of it", tabbedTo.inPicker, JSON.stringify(tabbedTo));

    const steppedFrom = await page.evaluate(() => document.querySelector(".date-picker__month")?.textContent);
    await page.locator(".date-picker__step").first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    const afterStep = await page.evaluate(() => ({
        month: document.querySelector(".date-picker__month")?.textContent,
        stillOnButton: document.activeElement?.classList.contains("date-picker__step"),
    }));
    check("Enter on a month stepper pages the month", afterStep.month !== steppedFrom,
        `${steppedFrom} -> ${afterStep.month}`);
    check("Enter on a month stepper leaves focus on the button, not in the grid",
        afterStep.stillOnButton, JSON.stringify(afterStep));

    // The consequence, stated as the thing a user would actually hit: press it
    // again and you page again, rather than inserting a date.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    check("a second Enter pages again rather than inserting a date",
        await page.evaluate(() => !!document.querySelector(".date-picker")), "");

    // ── 4. Escape closes, restores the caret, AND typing still works ────────
    // This is the arm the suite exists for. Asserting the picker went away
    // proves nothing about a contenteditable that lost its selection; the
    // only honest question is whether the next character lands where the
    // caret was, so the check types one.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const gone = await page.evaluate(() => !document.querySelector(".date-picker"));
    check("Escape closes the picker", gone, String(gone));

    await page.keyboard.type("X", { delay: 40 });
    await page.waitForTimeout(500);
    const afterEscape = await latest();
    check("Escape leaves the caret in the block it was in, so typing lands there",
        /First line\. X/.test(afterEscape ?? ""), JSON.stringify(afterEscape));
    check("Escape inserts no date", !/\d{4}/.test(afterEscape ?? ""), JSON.stringify(afterEscape));

    // ── 5. Enter on a day inserts it, as plain text, at the caret ───────────
    await mount();
    check("the probe placed the caret in the second paragraph", await caretAtEndOf("Second line."), "");
    await openPicker();
    const chosen = await page.evaluate(() => {
        const cell = [...document.querySelectorAll('[role="gridcell"]')]
            .find((c) => c.getAttribute("tabindex") === "0");
        return { label: cell?.getAttribute("aria-label"), day: cell?.textContent };
    });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);

    const afterPick = await latest();
    const pickedGone = await page.evaluate(() => !document.querySelector(".date-picker"));
    check("choosing a day closes the picker", pickedGone, String(pickedGone));
    check("the chosen day is written into the paragraph the caret was in",
        new RegExp(`Second line\\.[^\\n]*\\b${chosen.day}\\b`).test(afterPick ?? ""),
        JSON.stringify({ chosen, afterPick }));

    // Plain text and nothing else: no HTML, no marker syntax, and the line
    // still reads as an ordinary paragraph. This is the round-trip promise.
    const line = (afterPick ?? "").split("\n").find((l) => l.startsWith("Second line."));
    check("the insertion is plain text, with no markup around it",
        !!line && !/[<>[\]`*_]/.test(line.replace("Second line.", "")), JSON.stringify(line));

    // ── 6. Typing continues in the same block after a pick ──────────────────
    await page.keyboard.type("Y", { delay: 40 });
    await page.waitForTimeout(500);
    const afterTyping = await latest();
    const typedLine = (afterTyping ?? "").split("\n").find((l) => l.startsWith("Second line."));
    check("the caret is left after the inserted date, so typing continues there",
        !!typedLine && typedLine.trimEnd().endsWith("Y"), JSON.stringify(typedLine));

    // ── 7. A real MOUSE press on a day cell, which the keyboard arms miss ──
    // A pointer press is a different path from Enter and can fail on its own:
    // the press lands on an element outside the contenteditable, and whether
    // the editor gets its caret back afterwards is a browser question rather
    // than a ProseMirror one. jsdom cannot answer it, and a prop-level test
    // would not even reach it, so it is dispatched here in both engines.
    await mount();
    check("the probe placed the caret for the mouse case", await caretAtEndOf("Second line."), "");
    await openPicker();
    const clickTarget = await page.evaluate(() => {
        // A day inside the month, not the focused one, so the assertion can
        // tell a real pick from the default that Enter would have given.
        const cell = [...document.querySelectorAll('[role="gridcell"]')]
            .find((c) => !c.classList.contains("date-picker__day--outside")
                && c.getAttribute("tabindex") === "-1");
        return { day: cell?.textContent, label: cell?.getAttribute("aria-label") };
    });
    await page.locator('[role="gridcell"]:not(.date-picker__day--outside)')
        .filter({ hasText: new RegExp(`^${clickTarget.day}$`) }).first().click();
    await page.waitForTimeout(600);

    const afterClick = await latest();
    const clickedLine = (afterClick ?? "").split("\n").find((l) => l.startsWith("Second line."));
    check("clicking a day closes the picker",
        await page.evaluate(() => !document.querySelector(".date-picker")), "");
    check("a mouse-picked day is written into the paragraph the caret was in",
        !!clickedLine && new RegExp(`\\b${clickTarget.day}\\b`).test(clickedLine),
        JSON.stringify({ clickTarget, clickedLine }));

    // The half a pointer press can break on its own: the editor must hold the
    // caret after a press that landed outside it, so typing continues in place.
    await page.keyboard.type("Z", { delay: 40 });
    await page.waitForTimeout(500);
    const afterClickTyping = await latest();
    const typedAfterClick = (afterClickTyping ?? "").split("\n").find((l) => l.startsWith("Second line."));
    check("the caret survives a mouse pick, so typing continues after the date",
        !!typedAfterClick && typedAfterClick.trimEnd().endsWith("Z"), JSON.stringify(typedAfterClick));

    // ── 8. Dismissing by pressing outside writes nothing and gives focus back ─
    await mount();
    check("the probe placed the caret for the outside-press case", await caretAtEndOf("First line."), "");
    await openPicker();
    await page.locator(".milkdown .ProseMirror p").first().click();
    await page.waitForTimeout(300);
    check("a press outside the picker closes it",
        await page.evaluate(() => !document.querySelector(".date-picker")), "");
    const afterOutside = await latest();
    check("an outside press inserts no date",
        !/\d{4}/.test(afterOutside ?? ""), JSON.stringify(afterOutside));

    // ── 9. Opened next to the fixed chrome, it is neither under it nor in it ─
    // The failure this exists for is invisible to every arm above, because they
    // all put the caret in the middle of the document where nothing overlaps.
    // The topbar and the sticky heading title are fixed and opaque and paint
    // over the content, so a popup that opens into that band or sits below it
    // in the stack is unreachable while the code that placed it believes it
    // succeeded (docs/DESIGN_PRINCIPLES.md, "A floating surface fits the
    // visible area").
    await mount();
    check("the probe placed the caret in the first paragraph, next to the chrome",
        await caretAtEndOf("First line."), "");
    await openPicker();
    const stacking = await page.evaluate(() => {
        const root = document.querySelector(".date-picker");
        const bar = document.querySelector(".editor-topbar");
        const rect = root.getBoundingClientRect();
        const barRect = bar?.getBoundingClientRect();
        return {
            z: Number(getComputedStyle(root).zIndex),
            top: rect.top,
            barBottom: barRect?.bottom ?? 0,
            // What a user would actually hit: the element the browser finds at
            // the popup's own top-left corner has to be the popup.
            hitIsPicker: !!document
                .elementFromPoint(rect.left + 4, rect.top + 4)
                ?.closest(".date-picker"),
        };
    });
    check("the picker sits above the editor's floating chrome",
        stacking.z >= 1300, JSON.stringify(stacking));
    check("the picker opens below the fixed chrome, not into the band it paints over",
        stacking.top >= stacking.barBottom, JSON.stringify(stacking));
    check("the picker is what the pointer actually reaches at its own corner",
        stacking.hitIsPicker, JSON.stringify(stacking));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ── 9b. Scrolling under an open picker moves it with the caret ──────────
    // The popup is `position: fixed`, so a document scrolled beneath it stays
    // put unless something re-anchors it. Placing against a rectangle captured
    // at open would recompute the same answer forever and LOOK like
    // re-anchoring, so this asserts the popup actually moved by roughly what
    // the document moved by.
    await mount();
    // Mid-document, not the third block. Near the top the placement CORRECTLY
    // clamps to the usable area as the caret rides up under the fixed chrome,
    // and the sticky heading appearing changes that area during the very
    // measurement being taken, so the arm would be reading two effects at once.
    check("the probe placed the caret for the scroll case",
        await caretAtEndOf("Filler paragraph 20."), "");
    await openPicker();
    const beforeScroll = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        return el ? el.getBoundingClientRect().top : null;
    });
    check("the picker is open before the scroll", beforeScroll !== null, String(beforeScroll));
    const topbarBottom = await page.evaluate(() =>
        document.querySelector(".editor-topbar")?.getBoundingClientRect().bottom ?? 0);
    const scrolled = await page.evaluate(() => {
        const sc = document.scrollingElement ?? document.documentElement;
        const before = sc.scrollTop;
        sc.scrollTop = before + 120;
        return sc.scrollTop - before;
    });
    // Two frames, because the reflow tracker coalesces onto a rAF.
    await page.waitForTimeout(200);
    const afterScroll = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        return el ? el.getBoundingClientRect().top : null;
    });
    // A positive check, not one that only speaks on failure: this surface
    // deliberately does NOT hide when its anchor scrolls away, because the day
    // it is collecting lands at the caret whether or not the caret is on
    // screen, and a wheel nudge must not discard a half-made choice.
    check("the picker stays open through a scroll rather than dismissing",
        afterScroll !== null, String(afterScroll));
    if (scrolled === 0) {
        // The fixture is short enough not to scroll in some viewports. Say so
        // rather than passing an arm that measured nothing.
        check("the scroll probe actually scrolled the document", false, "scrollTop did not move");
    } else {
        check("the scroll probe actually scrolled the document", true, `by ${scrolled}px`);
        // It moved UP, toward where the caret went. Not "by exactly the scroll
        // distance": the placement clamps to the usable area, so a caret that
        // scrolls up past the fixed chrome leaves the popup resting at that
        // edge rather than travelling under it. What discriminates a live
        // anchor from a captured one is that the popup moved at all, and
        // upward, since a stale rectangle recomputes the same answer.
        check("the picker follows the caret when the document scrolls under it",
            afterScroll < beforeScroll - 20,
            JSON.stringify({ beforeScroll, afterScroll, scrolled }));
        check("and it stops at the usable edge rather than sliding under the chrome",
            afterScroll >= topbarBottom && (beforeScroll - afterScroll) <= scrolled + 4,
            JSON.stringify({ afterScroll, topbarBottom, scrolled }));
    }
    // Scrolling the OTHER way pushes the caret toward the bottom, which is the
    // direction `anchoredPlacement` does not clamp. This arm asserts the popup
    // stays open and on screen through it; what it does NOT do is reach the
    // extreme where the unclamped coordinate actually leaves the window, since
    // the fixture cannot be scrolled far enough for that. `datePicker.test.ts`
    // carries that case, where jsdom's absent layout leaves the arithmetic
    // exposed and a missing clamp fails immediately.
    await page.evaluate(() => {
        const sc = document.scrollingElement ?? document.documentElement;
        sc.scrollTop = Math.max(0, sc.scrollTop - 2000);
    });
    await page.waitForTimeout(250);
    const pushedDown = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        if (!el) { return null; }
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight };
    });
    check("the picker is still open after scrolling the caret off the bottom",
        pushedDown !== null, JSON.stringify(pushedDown));
    check("the picker stays on screen when its caret is below the viewport",
        !!pushedDown && pushedDown.bottom <= pushedDown.viewport + 1 && pushedDown.top >= 0,
        JSON.stringify(pushedDown));

    // Still open from the scroll arm: resizing the window must re-place it too.
    //
    // What this pins is re-placement, not WHICH element the reflow tracker
    // observes. Both are worth having and only one is checkable here: the
    // tracker also listens for scroll, and a resize reflows the document
    // enough to fire that, so this arm stays green with the observer pointed
    // at the wrong element. That choice rests on matching the five other
    // consumers, which all pass the editor's content box, and on a popup
    // being fixed-size so observing it reports nothing useful and feeds it its
    // own placement. Removing the tracking altogether does turn this red.
    const beforeResize = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        return el ? el.getBoundingClientRect().left : null;
    });
    // Narrow enough that the popup CANNOT stay where it was: without a
    // re-place it would hang off the right edge, so the arm discriminates.
    await page.setViewportSize({ width: 420, height: 900 });
    await page.waitForTimeout(300);
    const afterResize = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        return el ? { left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right } : null;
    });
    check("the picker is still there after a resize", afterResize !== null, JSON.stringify(afterResize));
    check("a window resize re-places the picker inside the new viewport",
        !!afterResize && afterResize.right <= 420,
        JSON.stringify({ beforeResize, afterResize }));
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForTimeout(200);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // ── 9c. A window too short to hold the calendar ─────────────────────────
    // Nothing above ever squeezes the popup, so the whole constrained path was
    // running untested: the height clamp, its own scroller, and the scrolling
    // that has to bring an arrowed-to day into view inside it. jsdom cannot see
    // any of it, since every offset there is 0.
    await page.setViewportSize({ width: 1000, height: 240 });
    await mount();
    check("the probe placed the caret in a short window", await caretAtEndOf("First line."), "");
    await openPicker();

    const squeezed = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        const r = el.getBoundingClientRect();
        return {
            bottom: r.bottom,
            top: r.top,
            viewport: window.innerHeight,
            overflows: el.scrollHeight > el.clientHeight,
        };
    });
    check("a short window squeezes the picker into its own scroller",
        squeezed.overflows, JSON.stringify(squeezed));
    // The clamp this surface owes because it declines to hide: an unclamped
    // flip-up returns a coordinate off the bottom of the screen, and the popup
    // would be invisible while still holding focus.
    check("the picker stays inside the viewport when it cannot fit beside the caret",
        squeezed.top >= 0 && squeezed.bottom <= squeezed.viewport + 1,
        JSON.stringify(squeezed));

    // Arrow down through the grid: the focused cell has to end up visible
    // INSIDE the popup's scroller, not merely focused off its bottom edge.
    // Down two weeks, which stays inside the drawn month: paging to another
    // month rebuilds the grid and resets the scroller, which would measure the
    // rebuild rather than the scrolling.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    const revealed = await page.evaluate(() => {
        const el = document.querySelector(".date-picker");
        const cell = document.activeElement;
        if (!el || !cell || cell.getAttribute("role") !== "gridcell") { return null; }
        const c = cell.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return { visible: c.top >= r.top - 1 && c.bottom <= r.bottom + 1, scrollTop: el.scrollTop };
    });
    // Honest about its reach, like the resize arm above: this pins that the
    // focused cell ends up visible inside the scroller, not the coordinate-space
    // fix behind it. A squeezed popup is always clamped near the top of the
    // viewport, so the popup's own `offsetTop` is small there and mixing it into
    // the cell's offset biases the result by too little to fail this. That fix
    // rests on `root` being the cell's offsetParent, which follows from the
    // popup being positioned, and on matching `langPicker.ts`'s idiom.
    check("arrowing to a day below the fold scrolls it into view inside the picker",
        !!revealed && revealed.visible, JSON.stringify(revealed));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForTimeout(200);

    // ── 10. A relative command writes the same spelling, with no picker ──────
    await mount();
    check("the probe placed the caret for the relative case", await caretAtEndOf("First line."), "");
    await page.keyboard.type(" /today", { delay: 40 });
    await page.waitForTimeout(250);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const noPicker = await page.evaluate(() => !document.querySelector(".date-picker"));
    check("/today opens no picker", noPicker, String(noPicker));
    const todayDoc = await latest();
    const todayLine = (todayDoc ?? "").split("\n").find((l) => l.startsWith("First line."));
    // Compared against the browser's OWN Intl, so the check does not restate
    // the format and cannot drift from it; what it pins is that the editor
    // used the runtime's locale rather than a pinned one.
    const expected = await page.evaluate(() => {
        const d = new Date();
        return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" })
            .format(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12));
    });
    check("/today writes today's date in the host locale's own spelling",
        !!todayLine && todayLine.includes(expected), JSON.stringify({ todayLine, expected }));
    check("/today leaves no slash query behind",
        !!todayLine && !todayLine.includes("/today"), JSON.stringify(todayLine));
}
