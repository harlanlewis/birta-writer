/**
 * A Mermaid label's ink has to land inside the box the label was given.
 *
 * The sibling suite `mermaidRender` measures rects, and rects are not what
 * broke: WebKit reported every foreignObject and every label div at exactly
 * the right coordinates while painting all of their content at the SVG's
 * origin, so that suite stayed green for the whole life of the defect. This
 * one reads pixels, which is the only place the two renders differ.
 *
 * Node has no PNG decoder and the harness ships no image dependency, so the
 * page decodes its own screenshot on a canvas. `tableGridlines` does the same
 * thing and is the place to look for the harder version of it: point sampling
 * against a paper reference, with device-pixel-ratio arithmetic. This suite
 * needs none of that, because the question is only whether a region holds any
 * ink at all, which no antialiasing can turn into a wrong answer.
 */

/**
 * How many labels the fixture's flowchart carries: four nodes and two edge
 * labels. The empty edge label the third edge gets is filtered out before this
 * is counted.
 */
const EXPECTED_LABELS = 6;

/** Fraction of dark pixels inside `rect`, decoded in-page from a screenshot. */
async function inkFraction(page, rect) {
    const shot = await page.screenshot({ clip: rect });
    return page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) dark++;
        }
        return data.length ? dark / (data.length / 4) : 0;
    }, shot.toString("base64"));
}

/** Every label box that actually holds text, in viewport coordinates. */
async function labelBoxes(page) {
    return page.evaluate(() => {
        const svg = document.querySelector(".mermaid-svg-container svg");
        if (!svg) return null;
        return [...svg.querySelectorAll("foreignObject")]
            .map((fo) => {
                const r = fo.getBoundingClientRect();
                return {
                    text: (fo.textContent ?? "").trim(),
                    x: r.x, y: r.y, width: r.width, height: r.height,
                };
            })
            .filter((b) => b.text && b.width >= 4 && b.height >= 4);
    });
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 20000 });
    // Let fit-to-view's rAF land before anything is measured or photographed:
    // the transform it writes moves every box this suite clips to.
    await page.waitForTimeout(1200);

    const boxes = await labelBoxes(page);
    // The sweep has to assert its own size: a selector that matched nothing
    // would leave the loop below with nothing to judge and report success.
    check("the diagram has labels to measure",
        boxes !== null && boxes.length === EXPECTED_LABELS,
        JSON.stringify(boxes?.map((b) => b.text)));

    const inks = [];
    for (const box of boxes ?? []) inks.push({ text: box.text, ink: +(await inkFraction(page, box)).toFixed(4) });
    const blank = inks.filter((i) => i.ink < 0.01).map((i) => i.text);
    // The count is half the verdict, not a restatement of the check above.
    // "No label was blank" is true of a run that found no labels, and the two
    // checks are reported independently, so without it a selector that matched
    // nothing would fail the first check and PASS this one.
    check("every label's ink is inside its own box",
        inks.length === EXPECTED_LABELS && blank.length === 0,
        blank.length ? `blank: ${blank.join(", ")} of ${inks.length} - ${JSON.stringify(inks)}` : JSON.stringify(inks));

    // The control the check above needs to be worth anything: a diagram whose
    // labels were painted somewhere else would leave ink at the SVG's origin,
    // and a suite that never looked there could not tell "painted correctly"
    // from "painted nothing at all".
    //
    // Coupled to the fixture's own diagram, deliberately. This corner is empty
    // in a correct render of THAT flowchart, whose first node starts well
    // right of it; a different diagram could legitimately draw something here
    // and the check would be measuring the wrong thing while still passing or
    // failing convincingly. Change the fence in index.html and re-derive it.
    const strayInk = await page.evaluate(() => {
        const svg = document.querySelector(".mermaid-svg-container svg");
        const r = svg.getBoundingClientRect();
        return { x: r.x, y: r.y, width: 70, height: 30 };
    });
    check("no ink piles up at the SVG's origin",
        (await inkFraction(page, strayInk)) < 0.01, JSON.stringify(strayInk));
}
