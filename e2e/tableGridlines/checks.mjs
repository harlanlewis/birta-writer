/**
 * Content-table gridlines and header wash, read back as real device pixels.
 *
 * WHY THIS SUITE EXISTS, beyond the defect it was written for. Every other
 * table fixture in e2e/ writes its own opaque `--vscode-panel-border`
 * (`#454545`, `#444444`). Those pages render tables perfectly well and cannot
 * see this class of defect at all, because the one property it depends on is
 * the property the fixture replaces. A guard whose subject is intact and whose
 * QUESTION is wrong stays green forever and reports nothing. This page links
 * `dist/hostPalette.css` instead, so the ink under test is the translucent one
 * every host actually ships.
 *
 * The defect: under `border-collapse` both cells either side of a gridline
 * paint it, so a translucent ink composites with itself. Chromium doubled it at
 * a crossing; WebKit doubled every interior gridline and reached eight layers
 * at a crossing. Separately, the `<table>` is its own scroll container
 * (`display: block; overflow-x: auto`) and a scroll container clips to its
 * padding box, which cost the outer left edge the outer half of its collapsed
 * border in WebKit.
 *
 * Both are invisible to jsdom, which has no layout engine and no compositor,
 * and both are invisible to a computed-style read, which reports the declared
 * colour and never how many times it was painted. Pixels are the only
 * instrument that answers either one.
 *
 * WebKit is not optional here. Chromium showed one of the two defects and at a
 * third of the severity, so a Chromium-only run would have called this fixed
 * while the Mac app still drew it. Run `BIRTA_E2E_BROWSER=webkit` too.
 */

/** Sum |Δ| across RGB — how far a pixel is from the paper behind it. */
const INK = "ink = per-channel distance from the cell's own background, summed over RGB";

export async function run({ page, check, baseUrl }) {
    let themesMeasured = 0;

    // The suite runs at BOTH device scale factors, and that is load-bearing
    // rather than thorough. The two halves of this defect do not both show at
    // one scale: the compositing shows at any, but the clipped outer half of
    // the collapsed left border is half a CSS pixel, which at scale 1 rounds
    // back to a whole device pixel and disappears. Verified by mutation —
    // reverting the padding/margin repair and leaving the opaque ink in place
    // passed every check at scale 1 and failed at scale 2. A guard that runs
    // at one scale is a guard for one of the two bugs.
    const runnerPage = page;
    const browser = page.context().browser();
    const hiDpiContext = await browser.newContext({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
    const hiDpiPage = await hiDpiContext.newPage();
    const hiDpiErrors = [];
    hiDpiPage.on("pageerror", (e) => hiDpiErrors.push(String(e)));

    for (const { scale, page } of [{ scale: 1, page: runnerPage }, { scale: 2, page: hiDpiPage }]) {
    for (const theme of ["light", "dark"]) {
        await page.goto(`${baseUrl}/index.html?theme=${theme}`);
        await page.waitForSelector(".milkdown .ProseMirror table", { timeout: 15000 });
        await page.waitForTimeout(300);

        const dsf = await page.evaluate(() => window.devicePixelRatio || 1);
        // Non-vacuity for the scale sweep itself: if the hi-dpi context did not
        // take, both passes measure the same pixels and the second one proves
        // nothing while doubling the PASS count, which reads like more coverage
        // rather than less.
        check(`[${theme} @${scale}x] the page really is rendering at ${scale}x`,
            dsf === scale, `devicePixelRatio=${dsf}`);

        // Geometry first, from the CELLS. Never from the <table> box: with
        // `display: block` that box is the scroll container and the real grid
        // is an anonymous table inside it, which shrink-to-fits — measuring the
        // container's right edge samples empty paper and reports "no border"
        // for a border that is plainly there.
        const geom = await page.evaluate(() => {
            const t = document.querySelectorAll(".ProseMirror table")[0];
            const rows = [...t.querySelectorAll("tr")];
            const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; };
            const bq = document.querySelectorAll(".ProseMirror table")[1];
            return {
                rowCount: rows.length,
                colCount: rows[0].children.length,
                rows: rows.map((tr) => ({ ...r(tr), cells: [...tr.children].map((c) => ({ tag: c.tagName, ...r(c) })) })),
                bqRows: bq ? [...bq.querySelectorAll("tr")].map((tr) => ({ cells: [...tr.children].map((c) => ({ tag: c.tagName, ...r(c) })) })) : null,
            };
        });

        // The fixture has to actually be the shape these checks assume. A
        // three-column, four-row table is what makes an interior crossing
        // exist at all; without it every ratio below is measured on nothing.
        check(`[${theme} @${scale}x] fixture is a 3-column, 4-row table with a header row`,
            geom.rowCount === 4 && geom.colCount === 3 && geom.rows[0].cells.every((c) => c.tag === "TH"),
            `rows=${geom.rowCount} cols=${geom.colCount} row0=${geom.rows[0].cells.map((c) => c.tag).join(",")}`);
        check(`[${theme} @${scale}x] and its body rows are data cells`,
            geom.rows[1].cells.every((c) => c.tag === "TD"),
            geom.rows[1].cells.map((c) => c.tag).join(","));

        // Screenshot, then read it back through a canvas: Playwright hands back
        // a PNG and the page itself is the decoder that is already here.
        const buf = await page.screenshot();
        await page.evaluate(async ({ dataUrl, dsf }) => {
            const img = new Image();
            await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
            const c = document.createElement("canvas");
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            window.__at = (cssX, cssY) => {
                const x = Math.round(cssX * dsf), y = Math.round(cssY * dsf);
                if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
                const i = (y * c.width + x) * 4;
                return [data[i], data[i + 1], data[i + 2]];
            };
        }, { dataUrl: `data:image/png;base64,${buf.toString("base64")}`, dsf });

        const m = await page.evaluate(({ g, dsf }) => {
            const at = window.__at;
            const d = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
            const r1 = g.rows[1], r2 = g.rows[2];
            const cell = r1.cells[1];
            // Paper reference: inside the cell's padding box (6px top /
            // 12px left), NEVER its centre — a centre sample lands on a glyph
            // and every number downstream then measures the text colour.
            const paper = at(cell.x + 6, cell.y + 3);

            // Integrate ink across a line rather than peaking on it: a line on
            // a fractional device pixel spreads over two rows without laying
            // down less ink, and a peak reading calls that "thinner" when it is
            // only "smeared". The integral is what tells a genuinely missing
            // half-pixel from an antialiased one.
            const scan = (cx, cy, axis, span = 3) => {
                let sum = 0;
                const half = Math.round(span * dsf);
                for (let s = -half; s <= half; s++) {
                    const p = axis === "x" ? at(cx + s / dsf, cy) : at(cx, cy + s / dsf);
                    if (p) sum += d(p, paper);
                }
                return sum;
            };
            const peak2d = (x, y, rad) => {
                let best = 0;
                for (let sx = -rad; sx <= rad; sx++) for (let sy = -rad; sy <= rad; sy++) {
                    const p = at(x + sx / dsf, y + sy / dsf);
                    if (p) best = Math.max(best, d(p, paper));
                }
                return best;
            };
            const peak1d = (x, y, axis, rad) => {
                let best = 0;
                for (let s = -rad; s <= rad; s++) {
                    const p = axis === "x" ? at(x + s / dsf, y) : at(x, y + s / dsf);
                    if (p) best = Math.max(best, d(p, paper));
                }
                return best;
            };

            const vX = r1.cells[0].right;                 // interior vertical gridline
            const hY = r1.bottom;                         // interior horizontal gridline
            const midY = (r1.y + r1.bottom) / 2;
            const midX = (cell.x + cell.right) / 2;

            const out = {
                paper,
                // Finding 1: is a crossing darker than the lines through it?
                nexusPeak: peak2d(vX, hY, 3),
                vLinePeak: peak1d(vX, midY, "x", 3),
                hLinePeak: peak1d(midX, hY, "y", 3),
                // Finding 3: does the outer left edge carry as much ink as an
                // interior gridline? Both are one nominal pixel of the same
                // declared colour, so anything else is a rendering loss.
                leftEdge: scan(r1.cells[0].x, midY, "x"),
                interiorV: scan(vX, midY, "x"),
                rightEdge: scan(r1.cells[r1.cells.length - 1].right, midY, "x"),
                topEdge: scan(midX, g.rows[0].y, "y"),
                bottomEdge: scan(midX, g.rows[g.rows.length - 1].bottom, "y"),
                interiorH: scan(midX, hY, "y"),
            };

            // Finding 2: the header wash, on the editor's paper and on the
            // blockquote's different ground. What must hold is not that the two
            // are the same colour (they cannot be, the grounds differ) but that
            // the wash pulls the header the SAME WAY on both — toward the ink.
            // A fixed mid-gray fails exactly that on a ground near mid-gray.
            const headerPx = at(cell.x + 6, g.rows[0].y + 8);
            const bodyPx = at(cell.x + 6, r1.y + 3);
            out.headerVsBody = d(headerPx, bodyPx);
            out.headerPx = headerPx;
            out.bodyPx = bodyPx;
            if (g.bqRows) {
                const b0 = g.bqRows[0].cells[0], b1 = g.bqRows[1].cells[0];
                const bqHeaderPx = at(b0.x + 6, b0.y + 8);
                const bqBodyPx = at(b1.x + 6, b1.y + 3);
                out.bqHeaderVsBody = d(bqHeaderPx, bqBodyPx);
                out.bqHeaderPx = bqHeaderPx;
                out.bqBodyPx = bqBodyPx;
            }
            return out;
        }, { g: geom, dsf });

        // ── Non-vacuity first. Every ratio below divides by a line's ink, and
        // a blank page or a failed readback makes those zero, at which point
        // the ratios are 0/0 and every comparison passes having measured
        // nothing. Assert the instrument reached a real gridline before
        // believing anything it says about one.
        check(`[${theme} @${scale}x] the probe found a real gridline to measure (${INK})`,
            m.vLinePeak > 25 && m.hLinePeak > 25 && m.interiorV > 40,
            `vPeak=${m.vLinePeak} hPeak=${m.hLinePeak} interiorV=${m.interiorV}`);

        // ── Finding 1: a crossing is one gridline's weight, not two ──────────
        // A translucent ink cannot pass this: it composites with itself wherever
        // two gridlines meet, so a crossing is two layers where Chromium
        // draws it and eight where WebKit does. The ceiling sits well clear of
        // what either produces; `node e2e/run.mjs tableGridlines` prints the
        // ratio each run rather than leaving a figure here to rot.
        const linePeak = Math.max(m.vLinePeak, m.hLinePeak);
        const nexusRatio = m.nexusPeak / Math.max(1, linePeak);
        check(`[${theme} @${scale}x] a gridline crossing is no darker than the lines through it`,
            nexusRatio <= 1.25,
            `nexus=${m.nexusPeak} line=${linePeak} ratio=${nexusRatio.toFixed(3)}`);

        // ── Finding 3: every edge of the grid weighs the same ────────────────
        // The outer edges are the ones a scroll container can clip, and the
        // left edge is the one that was clipped. The other three were already
        // whole, so the check covers all four rather than only the one that was
        // broken: an edge that starts failing later is the case this is for.
        for (const [name, value] of [["left", m.leftEdge], ["right", m.rightEdge], ["top", m.topEdge], ["bottom", m.bottomEdge]]) {
            const interior = name === "left" || name === "right" ? m.interiorV : m.interiorH;
            const ratio = value / Math.max(1, interior);
            // The top edge is the one asymmetric case: its scan runs from plain
            // paper into the header wash, so it integrates the wash as well as
            // the line and reads well above an interior gridline whatever the
            // ink is. A ceiling there would be measuring the wash, so it gets a
            // floor only — and its name has to say so, because a check called
            // "weighs the same" that passes at 2.1x is a check whose name is a
            // claim nobody made.
            const ok = name === "top" ? ratio >= 0.75 : ratio >= 0.75 && ratio <= 1.35;
            const claim = name === "top"
                ? `the grid's outer top edge loses no ink against an interior gridline (its scan also crosses the header wash, so only a loss is meaningful)`
                : `the grid's outer ${name} edge weighs the same as an interior gridline`;
            check(`[${theme} @${scale}x] ${claim}`, ok, `${name}=${value} interior=${interior} ratio=${ratio.toFixed(3)}`);
        }

        // ── Finding 2: the header wash reads as a wash on any ground ─────────
        check(`[${theme} @${scale}x] the header row is washed against its own body cells`,
            m.headerVsBody >= 12, `headerVsBody=${m.headerVsBody} header=${JSON.stringify(m.headerPx)} body=${JSON.stringify(m.bodyPx)}`);
        check(`[${theme} @${scale}x] …and still is on a ground that is not the editor's paper`,
            m.bqHeaderVsBody >= 12, `bqHeaderVsBody=${m.bqHeaderVsBody} header=${JSON.stringify(m.bqHeaderPx)} body=${JSON.stringify(m.bqBodyPx)}`);
        // Direction, not just presence. In a light theme the wash must DARKEN
        // the header and in a dark theme LIGHTEN it, on both grounds. A fixed
        // mid-gray gets this wrong on a ground the other side of mid-gray, and
        // a presence-only check cannot tell the two apart.
        const lum = (p) => p[0] + p[1] + p[2];
        const wantDarker = theme === "light";
        const dirOk = (h, b) => (wantDarker ? lum(h) < lum(b) : lum(h) > lum(b));
        check(`[${theme} @${scale}x] the wash moves the header toward the ink on both grounds`,
            dirOk(m.headerPx, m.bodyPx) && dirOk(m.bqHeaderPx, m.bqBodyPx),
            `editor ${lum(m.headerPx)} vs ${lum(m.bodyPx)}; quote ${lum(m.bqHeaderPx)} vs ${lum(m.bqBodyPx)}`);

        themesMeasured++;
    }
    }

    // The nested loops above ARE the coverage, so their own size is the
    // assertion: a navigation that silently failed would leave those checks
    // unrun and the suite would report nothing rather than a failure. Two
    // themes times two scale factors.
    check("both themes were measured at both scale factors", themesMeasured === 4, `passes=${themesMeasured}`);

    // The runner's own pageerror listener watches only the page it made, so
    // the hi-dpi one needs its own or half the suite runs unwatched.
    check("no page errors on the hi-dpi page", hiDpiErrors.length === 0, hiDpiErrors.slice(0, 3).join(" | "));
    await hiDpiContext.close();
}
