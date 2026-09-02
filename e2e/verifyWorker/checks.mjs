/**
 * MAR-430 — the verify worker, in a real browser under the provider's CSP.
 *
 * jsdom has no Worker, so the unit suite drives the off-thread path with an
 * injected oracle and can say nothing about whether a real worker starts
 * under a real policy, answers, and is what the sync waited on. What must
 * hold here, in Chromium and in WebKit:
 *
 *   - on a document past the off-thread floor, an edit's update carries the
 *     edit, exactly one worker was started, and every `merge` pass the burst
 *     stamped reparsed off the main thread (`mainReparses` zero, `reparses`
 *     at least one: the fixture is spelled so the reparse cannot short-circuit);
 *   - the bytes the update carries keep the file's own spelling, so the
 *     answer was a verdict and not a fallback;
 *   - a document below the floor starts no worker and reparses on the main
 *     thread, so the floor is a floor and not a switch that fell.
 */

const marked = (page, name) =>
    page.waitForFunction(
        (n) => performance.getEntriesByName("mdw:" + n, "mark").length > 0,
        name,
        { timeout: 20000 },
    );

/** Every `mdw:merge` mark's detail, summed by key. */
const mergeWork = (page) =>
    page.evaluate(() => {
        const sum = {};
        for (const e of performance.getEntriesByName("mdw:merge", "mark")) {
            for (const [k, v] of Object.entries(e.detail ?? {})) sum[k] = (sum[k] ?? 0) + v;
        }
        return sum;
    });

async function typeAndSync(page, text) {
    await page.evaluate(() => { window.__posted.length = 0; });
    await page.click(".milkdown .ProseMirror p");
    await page.keyboard.press("End");
    await page.keyboard.type(text);
    await page.waitForFunction(
        (t) => window.__posted.some((m) => m.type === "update" && typeof m.content === "string" && m.content.includes(t)),
        text,
        { timeout: 20000 },
    );
    // The update that carries the whole text, not the first: a slower engine
    // syncs the leading edge after the first character alone.
    return page.evaluate(
        (t) => window.__posted.find((m) => m.type === "update" && m.content.includes(t)).content,
        text,
    );
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await marked(page, "editor-painted");
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });

    const docLength = await page.evaluate(() => window.__docLength);
    check("the fixture is past the off-thread floor", docLength > 100000, `chars=${docLength}`);

    const content = await typeAndSync(page, "QQ");
    check("the update carries the edit", content.includes("Opening paragraph.QQ"), JSON.stringify(content.slice(0, 120)));
    check("the update keeps the file's own four-space spelling, so the verdict was a verdict and not a fallback",
        content.includes("\n    - nested under one of 1\n"), JSON.stringify(content.slice(0, 400)));

    const workers = await page.evaluate(() => window.__workers);
    check("exactly one worker was started", workers === 1, `workers=${workers}`);

    const work = await mergeWork(page);
    check("at least one sync pass reparsed", (work.passes ?? 0) >= 1 && (work.reparses ?? 0) >= 1, JSON.stringify(work));
    check("and none of those reparses ran on the main thread", work.mainReparses === 0, JSON.stringify(work));

    // A second edit after the first answered: the worker is warm and reused,
    // not restarted, and the ordering rule let the first commit.
    const second = await typeAndSync(page, "RR");
    check("a second edit syncs through the same worker", second.includes("Opening paragraph.QQRR"), JSON.stringify(second.slice(0, 120)));
    const workersAfter = await page.evaluate(() => window.__workers);
    check("and no second worker was started", workersAfter === 1, `workers=${workersAfter}`);

    // ── Below the floor: the synchronous pipeline, untouched ──
    await page.goto(`${baseUrl}/index.html?small=1`);
    await marked(page, "editor-painted");
    const smallLength = await page.evaluate(() => window.__docLength);
    check("the small fixture is below the floor", smallLength < 100000, `chars=${smallLength}`);
    const smallContent = await typeAndSync(page, "SS");
    check("the small document's update carries the edit", smallContent.includes("Opening paragraph.SS"));
    const smallWorkers = await page.evaluate(() => window.__workers);
    check("no worker is started for a document below the floor", smallWorkers === 0, `workers=${smallWorkers}`);
    const smallWork = await mergeWork(page);
    check("and its reparse ran on the main thread, as before",
        (smallWork.reparses ?? 0) >= 1 && smallWork.mainReparses === smallWork.reparses, JSON.stringify(smallWork));
}
