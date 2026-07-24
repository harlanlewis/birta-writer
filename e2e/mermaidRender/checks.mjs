/**
 * Mermaid render pipeline (MAR-202/203/205) — real layout truths jsdom can't
 * reach, against the real Mermaid bundle:
 *   - the no-clipping invariant: every HTML label's content fits the width
 *     Mermaid allotted it (regression: re-renders used to measure labels
 *     inside the pan/zoom-scaled container, so after the first fit-to-view
 *     every re-render clipped/mis-sized its text),
 *   - edit → back to preview re-renders CLEAN (the user-reported corruption),
 *   - fit-to-view rests at ≤100% and never blows small-enough content up,
 *   - a theme-changed event actually repaints an already-rendered diagram
 *     (regression: the memo guard made the theme re-render a silent no-op).
 */

/** Max px a label's real content may exceed Mermaid's allotted width. */
const CLIP_TOLERANCE = 2;

async function clipStats(page) {
    return page.evaluate(() => {
        const svg = document.querySelector(".mermaid-svg-container svg");
        if (!svg) return null;
        return [...svg.querySelectorAll("foreignObject")].map((fo) => {
            const div = fo.querySelector("div");
            return {
                allotted: parseFloat(fo.getAttribute("width") ?? "0"),
                content: div ? div.scrollWidth : 0,
            };
        }).filter((s) => s.content > 0);
    });
}

function worstOverflow(stats) {
    return Math.max(0, ...stats.map((s) => s.content - s.allotted));
}

async function fitScale(page) {
    return page.evaluate(() => {
        const m = /scale\(([\d.]+)\)/.exec(
            document.querySelector(".mermaid-svg-container")?.style.transform ?? "");
        return m ? parseFloat(m[1]) : null;
    });
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // Auto-preview mounts, lazily loads the real Mermaid chunk, and renders.
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 20000 });
    await page.waitForTimeout(400); // let fitToView's rAF settle

    // ── Initial render: labels fit, and the fixture really exercises fit<1 ──
    const initialStats = await clipStats(page);
    check("initial render has measurable labels", initialStats !== null && initialStats.length >= 6,
        JSON.stringify(initialStats?.length));
    check("initial render does not clip labels",
        worstOverflow(initialStats) <= CLIP_TOLERANCE, JSON.stringify(initialStats));
    const naturalW1 = await page.evaluate(() =>
        parseFloat(document.querySelector(".mermaid-svg-container svg")?.getAttribute("width") ?? "0"));
    const scale1 = await fitScale(page);
    check("fixture rests below 100% fit (the corruption precondition)",
        scale1 !== null && scale1 < 0.999, JSON.stringify(scale1));

    // ── The user's repro: toggle to code, edit the definition, toggle back ──
    await page.click(".code-view-toggle-btn");
    await page.waitForTimeout(100);
    const endPos = await page.evaluate(() => {
        const code = document.querySelector(".code-block-wrapper code");
        const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walk.nextNode())) {
            const i = n.textContent.indexOf("LongEnd");
            if (i >= 0) {
                const r = document.createRange();
                r.setStart(n, i); r.setEnd(n, i + 7);
                const rect = r.getBoundingClientRect();
                return { x: rect.x + rect.width - 2, y: rect.y + rect.height / 2 };
            }
        }
        return null;
    });
    check("code mode shows the editable source", endPos != null);
    await page.mouse.click(endPos.x, endPos.y);
    // An "X" lands in/next to "LongEnd" (exact caret slot doesn't matter —
    // no label contains an X before the edit, so X marks the re-render).
    await page.keyboard.type("X");
    await page.waitForTimeout(100);
    await page.click(".code-view-toggle-btn"); // back to preview → re-render
    await page.waitForFunction(
        () => {
            const t = document.querySelector(".mermaid-svg-container svg")?.textContent ?? "";
            return t.includes("X") && t.includes("LongEn");
        },
        { timeout: 20000 },
    );
    await page.waitForTimeout(400);

    const rerenderStats = await clipStats(page);
    check("re-render after an edit does not clip labels (MAR-202)",
        worstOverflow(rerenderStats) <= CLIP_TOLERANCE, JSON.stringify(rerenderStats));
    const scale2 = await fitScale(page);
    check("re-rendered diagram is refit, capped at 100% (MAR-205)",
        scale2 !== null && scale2 > 0 && scale2 <= 1.001, JSON.stringify(scale2));

    // The corrupted pipeline scaled the whole layout by the resting zoom on
    // every pass (natural width ≈ w1 × fit-scale after one re-render); a
    // clean re-render of near-identical content keeps a near-identical width.
    const naturalW2 = await page.evaluate(() =>
        parseFloat(document.querySelector(".mermaid-svg-container svg")?.getAttribute("width") ?? "0"));
    check("re-render keeps the natural layout width stable (MAR-202)",
        naturalW1 > 0 && Math.abs(naturalW2 - naturalW1) < naturalW1 * 0.15,
        JSON.stringify({ naturalW1, naturalW2 }));

    // ── Theme change repaints in place (was a silent no-op, MAR-203) ──
    await page.evaluate(() => {
        const svg = document.querySelector(".mermaid-svg-container svg");
        svg.setAttribute("data-e2e-old", "1");
        window.dispatchEvent(new CustomEvent("theme-changed"));
    });
    await page.waitForFunction(
        () => {
            const svg = document.querySelector(".mermaid-svg-container svg");
            return svg && !svg.hasAttribute("data-e2e-old");
        },
        { timeout: 20000 },
    );
    await page.waitForTimeout(400);
    const themedStats = await clipStats(page);
    check("theme-triggered re-render is clean too",
        worstOverflow(themedStats) <= CLIP_TOLERANCE, JSON.stringify(themedStats));
}
