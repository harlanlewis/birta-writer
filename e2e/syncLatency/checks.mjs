/**
 * View→document sync latency checks against the real bundle (MAR-145).
 *
 * CLAUDE.md's sync invariant #2: "An edit is save-capturable the moment the
 * user perceives it. The first edit after a save dirties the TextDocument
 * within an IPC hop (leading-edge sync)." `onWillSaveTextDocument` only fires
 * for a DIRTY document, so if the first keystroke takes ~200ms to produce an
 * `update`, a Cmd+S inside that window is a silent no-op — the keystroke isn't
 * written. The latency is invisible to the jsdom unit suite (which drives the
 * scheduler directly and never sees the plugin layers above it), so it can only
 * be measured by driving dist/webview.js in a real browser.
 *
 * The regression this guards: `_scheduler.request()` used to be reachable only
 * from `@milkdown/plugin-listener`'s `updated`, which wraps every callback in a
 * lodash `debounce(fn, 200)` (trailing) — defeating the leading edge entirely.
 */

/** Type one character and return ms from keypress to the first `update` post. */
async function measureFirstEditLatency(page) {
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.click(".milkdown .ProseMirror p");
    // Settle past any idle window so the next edit is a genuine leading edge.
    await page.waitForTimeout(400);

    const start = await page.evaluate(() => {
        window.__typedAt = performance.now();
        return window.__typedAt;
    });
    await page.keyboard.type("X");

    await page.waitForFunction(
        () => window.__posted.some((m) => m.type === "update"),
        undefined,
        { timeout: 5000 },
    );
    return await page.evaluate(() => {
        const first = window.__posted.find((m) => m.type === "update");
        return first.__t - window.__typedAt;
    });
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    // ── The leading edge: first edit after a lull ──
    const first = await measureFirstEditLatency(page);
    // The bar is "within an IPC hop" — the scheduler arms at delay 0, so the
    // update is one macrotask + one serialize away. 50ms is loose enough to
    // absorb CI jitter and a cold serializer while still failing hard on the
    // 200ms plugin-listener debounce this regression is about.
    check(`first edit dirties the document in ~one frame (${first.toFixed(0)}ms)`,
        first < 50, `${first.toFixed(0)}ms — expected < 50ms`);

    // ── The content actually shipped ──
    const shipped = await page.evaluate(() =>
        window.__posted.find((m) => m.type === "update")?.content ?? "");
    check("the first update carries the typed character",
        shipped.includes("X"), JSON.stringify(shipped));

    // ── A second lull → the leading edge re-arms (not stuck in trailing) ──
    const second = await measureFirstEditLatency(page);
    check(`leading edge re-arms after a lull (${second.toFixed(0)}ms)`,
        second < 50, `${second.toFixed(0)}ms — expected < 50ms`);

    // ── Invariant #3: continuous typing still syncs, bounded by maxWaitMs ──
    // The crash-safety window. A *trailing* debounce upstream of the scheduler
    // starved this completely: typing faster than its 200ms wait reset the timer
    // every keystroke, so the scheduler was never even asked for a sync and its
    // maxWaitMs cap could never engage — the TextDocument (which hot exit backs
    // up) trailed the editor by the entire length of the burst.
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.waitForTimeout(400);
    const burst = await page.evaluate(async () => {
        const start = performance.now();
        // ~3s of keystrokes at 60ms — never a pause long enough to end a
        // trailing 200ms debounce, and past syncScheduler's 2000ms max-wait.
        for (let i = 0; i < 50; i++) {
            document.execCommand("insertText", false, "a");
            await new Promise((r) => setTimeout(r, 60));
        }
        const first = window.__posted.find((m) => m.type === "update");
        return { start, firstAt: first ? first.__t : null };
    });
    check("continuous typing syncs within the max-wait cap (never starves)",
        burst.firstAt !== null && burst.firstAt - burst.start < 2500,
        burst.firstAt === null
            ? "no update posted during a 3s continuous burst"
            : `${(burst.firstAt - burst.start).toFixed(0)}ms`);
}
