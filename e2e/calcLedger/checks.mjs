/**
 * ```calc ledger (MAR-196) — real-browser truths jsdom can't reach:
 *   - a mouse drag INSIDE the ledger survives and selects source + value
 *     (regression: ProseMirror used to wipe the selection on every mousemove
 *     until the NodeView's ignoreMutation ignored ledger selections),
 *   - the selected text carries the real-text `= value` lead-in (so a copy
 *     reads `source` / `= value`, not bare numbers),
 *   - value rows show `= value`; a `=>`-suffixed source row does NOT double it,
 *   - a formula-shaped line with no value shows the quiet error dash while
 *     plain prose shows nothing,
 *   - clicking back into prose still gives the editor a normal caret,
 *   - with birta.calc.blocks.enabled off (?blocksOff=1) the fence is an
 *     ordinary code block: no ledger, no auto-preview, no preview toggle.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".calc-row", { timeout: 10000 });
    await page.waitForTimeout(300);

    const rows = await page.$$eval(".calc-row", (els) =>
        els.map((el) => ({
            src: el.querySelector(".calc-row-src")?.textContent ?? "",
            result: el.querySelector(".calc-row-result")?.textContent ?? null,
            error: !!el.querySelector(".calc-row-result--error"),
        })),
    );

    const total = rows.find((r) => r.src.startsWith("total"));
    check("value rows carry the real-text `= ` lead-in", total?.result === "= 6500",
        JSON.stringify(total));
    const km = rows.find((r) => r.src.includes("km in mi"));
    check("a `=>`-suffixed source row does not double the lead-in",
        km?.result === "1.864114", JSON.stringify(km));
    const oops = rows.find((r) => r.src.startsWith("oops"));
    check("a formula-shaped failure shows the quiet error dash",
        oops?.error === true && oops?.result === "—", JSON.stringify(oops));
    const prose = rows.find((r) => r.src.startsWith("plain words"));
    check("plain prose shows no cue at all",
        prose != null && prose.result === null && !prose.error, JSON.stringify(prose));

    // ── The selection regression: drag across the total row ──
    const rowIndex = rows.findIndex((r) => r.src.startsWith("total")) + 1;
    const srcBox = await (await page.$(`.calc-row:nth-child(${rowIndex}) .calc-row-src`)).boundingBox();
    const resBox = await (await page.$(`.calc-row:nth-child(${rowIndex}) .calc-row-result`)).boundingBox();
    // A red here reads as `""`, and three different failures produce that same
    // empty string: the press landed on nothing, the ledger repainted out from
    // under the gesture, or a selection was made and then destroyed mid-drag.
    // Watch all three across the drag so ONE red run says which, rather than
    // costing a session of reruns to reproduce (MAR-359).
    await page.evaluate(() => {
        const w = { repaints: 0, escaped: null, t0: performance.now() };
        window.__dragWatch = w;
        w.obs = new MutationObserver((recs) => { w.repaints += recs.length; });
        w.obs.observe(document.querySelector(".calc-render"),
            { childList: true, subtree: true, characterData: true });
        w.onSel = () => {
            const node = window.getSelection()?.anchorNode;
            const el = node?.nodeType === 1 ? node : node?.parentElement;
            if (w.escaped || !el || el.closest(".calc-render")) { return; }
            w.escaped = {
                ms: Math.round(performance.now() - w.t0),
                at: el.className || el.nodeName,
            };
        };
        document.addEventListener("selectionchange", w.onSel);
    });
    const pressX = srcBox.x + 2, pressY = srcBox.y + srcBox.height / 2;
    await page.mouse.move(pressX, pressY);
    // Did the press land on the row it aimed at? A press that misses, because
    // the block re-rendered between the box read and the press, leaves exactly
    // the empty selection a destroyed drag does. Asked at the press itself: a
    // second boundingBox read is only a proxy for the same question.
    const pressLanded = await page.evaluate(([x, y]) => {
        // Time the watcher from the press, so a reported "Nms in" is directly
        // comparable to the editor's own post-focus deadline.
        window.__dragWatch.t0 = performance.now();
        return !!document.elementFromPoint(x, y)?.closest(".calc-row-src");
    }, [pressX, pressY]);
    await page.mouse.down();
    await page.mouse.move(resBox.x + resBox.width - 2, resBox.y + resBox.height / 2, { steps: 12 });
    await page.mouse.up();
    const dragWatch = await page.evaluate(() => {
        const w = window.__dragWatch;
        w.obs.disconnect();
        document.removeEventListener("selectionchange", w.onSel);
        return { repaints: w.repaints, escaped: w.escaped, collapsed: window.getSelection()?.isCollapsed };
    });

    // Poll for the selection instead of reading once after a fixed wait: a
    // synthetic drag settles on the browser's own schedule, and 150 ms is not
    // always enough. The poll absorbs a slow settle and nothing else. An empty
    // string at the END of it is NOT proof of a regression, which is what the
    // watcher above is for: the drag can also be destroyed in flight, and then
    // every poll sees the same empty string a fixed wait would (MAR-359).
    const settledSelection = async (predicate) => {
        let text = "";
        for (let i = 0; i < 40; i++) {
            text = await page.evaluate(() => window.getSelection()?.toString() ?? "");
            if (predicate(text)) return text;
            await page.waitForTimeout(25);
        }
        return text;
    };

    const dragText = await settledSelection(
        (t) => t.includes("total = rent + budget") && t.includes("6500"),
    );
    const dragOk = dragText.includes("total = rent + budget") && dragText.includes("6500");
    check("a mouse drag in the ledger survives (ignoreMutation)", dragOk,
        dragOk ? JSON.stringify(dragText) : [
            JSON.stringify(dragText),
            `pressLanded=${pressLanded}`,
            `ledgerRepaints=${dragWatch.repaints}`,
            `endedCollapsed=${dragWatch.collapsed}`,
            dragWatch.escaped
                // The known cause, and the one this drag cannot defend against:
                // the editor took focus on the press, and prosemirror-view's
                // post-focus timer wrote its OWN selection over the drag while
                // the mouse was still down. Its guard against exactly that is
                // keyed on `view.input.mouseDown`, which the ledger NodeView's
                // stopEvent deliberately prevents from ever being set.
                ? `selection left the ledger ${dragWatch.escaped.ms}ms after the press, to "${dragWatch.escaped.at}": the editor overwrote the drag (MAR-359)`
                : "selection never left the ledger",
        ].join(" | "));

    await page.mouse.dblclick(srcBox.x + 10, srcBox.y + srcBox.height / 2);
    const dblText = await settledSelection((t) => t.trim().length > 0);
    check("double-click selects a ledger word", dblText.trim().length > 0, JSON.stringify(dblText));

    // ── The editor still owns selection everywhere else ──
    const prosePos = await page.evaluate(() => {
        const walk = document.createTreeWalker(
            document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
            const i = n.textContent.indexOf("after prose");
            if (i >= 0) {
                const r = document.createRange();
                r.setStart(n, i); r.setEnd(n, i + 3);
                const rect = r.getBoundingClientRect();
                return { x: rect.x + 2, y: rect.y + rect.height / 2 };
            }
        }
        return null;
    });
    check("prose paragraph found", prosePos != null);
    if (prosePos) {
        await page.mouse.click(prosePos.x, prosePos.y);
        await page.waitForTimeout(100);
        const caretInProse = await page.evaluate(() => {
            const sel = window.getSelection();
            return !!sel && sel.isCollapsed
                && !!sel.anchorNode
                && (sel.anchorNode.textContent ?? "").includes("after prose");
        });
        check("clicking prose restores a normal editor caret", caretInProse);
    }

    // ── Clicking the ledger leaves the editor INERT (no stale-caret edits) ──
    if (prosePos) {
        await page.mouse.click(prosePos.x, prosePos.y); // park a live caret in prose
        await page.waitForTimeout(80);
        const parasBefore = await page.$$eval(".ProseMirror p", (els) => els.length);
        await page.mouse.click(srcBox.x + 4, srcBox.y + srcBox.height / 2); // into the ledger
        await page.waitForTimeout(80);
        await page.keyboard.press("Enter");
        await page.keyboard.type("zz");
        await page.waitForTimeout(120);
        const parasAfter = await page.$$eval(".ProseMirror p", (els) => els.length);
        const leaked = await page.evaluate(() =>
            (document.querySelector(".ProseMirror")?.textContent ?? "").includes("zz"));
        check("Enter/typing after a ledger click edits nothing (editor inert)",
            parasAfter === parasBefore && !leaked,
            `paras ${parasBefore}→${parasAfter}, leaked=${leaked}`);
        // …and clicking back into prose restores a live editor.
        await page.mouse.click(prosePos.x, prosePos.y);
        await page.waitForTimeout(80);
        await page.keyboard.type("Q");
        await page.waitForTimeout(120);
        const typed = await page.evaluate(() =>
            (document.querySelector(".ProseMirror")?.textContent ?? "").includes("Q"));
        check("clicking back into prose restores normal typing", typed);
    }

    // ── Disabled gate: the fence is an ordinary code block ──
    await page.goto(`${baseUrl}/index.html?blocksOff=1`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".code-block-wrapper", { timeout: 10000 });
    await page.waitForTimeout(400);
    check("blocks off: no ledger rows",
        (await page.$$(".calc-row")).length === 0);
    const preHidden = await page.$eval(".code-block-wrapper pre",
        (el) => el.classList.contains("code-pre--preview-hidden"));
    check("blocks off: source stays visible (no auto-preview)", preHidden === false);
    // The control column mounts EMPTY and builds its buttons on first reveal
    // (webview/ui/blockControls.ts), so the toggle only exists once the block
    // has been hovered — and "exists but display:none" is exactly what this
    // check needs to tell apart from "gated off".
    await page.hover(".code-block-wrapper pre");
    const toggleDisplay = await page.$eval(".code-view-toggle-btn",
        (el) => getComputedStyle(el).display);
    check("blocks off: no preview toggle", toggleDisplay === "none");
}
