/**
 * Template directives drawn as source (plugins/templateDirectives.ts).
 *
 * The unit suite proves which spans are directives and which soft breaks
 * should end a line. What only a browser can answer is whether the drawing
 * does what it claims: that a directive alone on its line really sits on its
 * own line (the zero-height block break), that a directive inside a sentence
 * does not, and that the caret still works around a break drawn that way,
 * which is WebKit's to get wrong.
 *
 * Run under BOTH engines:
 *   node e2e/run.mjs templateDirectives
 *   BIRTA_E2E_BROWSER=webkit node e2e/run.mjs templateDirectives
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // The first pass is deferred to an idle slot after first paint.
    await page.waitForFunction(() => document.querySelectorAll(".tpl-directive").length >= 4, null, { timeout: 10000 });

    const texts = await page.$$eval(".tpl-directive", (els) => els.map((el) => el.textContent));
    check("each directive is drawn as source",
        ["{{< shots >}}", "{{< /shots >}}", "{% if page.draft %}", "{{ site.title }}"].every((t) => texts.includes(t)),
        JSON.stringify(texts));
    check("an inline code span is never drawn as a directive",
        !texts.some((t) => t.includes("code")), JSON.stringify(texts));

    const look = await page.evaluate(() => {
        const el = document.querySelector(".tpl-directive");
        const cs = getComputedStyle(el);
        const p = getComputedStyle(el.closest("p"));
        return { family: cs.fontFamily, size: parseFloat(cs.fontSize), proseSize: parseFloat(p.fontSize) };
    });
    check("a directive is drawn in the monospace face, smaller than the prose",
        /monospace/.test(look.family) && look.size < look.proseSize, JSON.stringify(look));

    /** The top of each piece of a paragraph, by its text or its element. */
    const tops = await page.evaluate(() => {
        const paras = [...document.querySelectorAll(".ProseMirror > p")];
        const top = (node) => Math.round(node.getBoundingClientRect().top);
        const textTop = (p, needle) => {
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const i = n.data.indexOf(needle);
                if (i >= 0) {
                    const r = document.createRange();
                    r.setStart(n, i);
                    r.setEnd(n, i + needle.length);
                    return Math.round(r.getBoundingClientRect().top);
                }
            }
            return null;
        };
        const shots = paras.find((p) => p.textContent.includes("shots"));
        const prose = paras.find((p) => p.textContent.includes("prose above"));
        const inline = paras.find((p) => p.textContent.includes("stays in its sentence"));
        const imgs = [...(shots?.querySelectorAll("img:not(.ProseMirror-separator)") ?? [])];
        return {
            shots: {
                open: textTop(shots, "{{< shots >}}"),
                firstImg: imgs[0] ? top(imgs[0]) : null,
                lastImgBottom: imgs[1] ? Math.round(imgs[1].getBoundingClientRect().bottom) : null,
                close: textTop(shots, "{{< /shots >}}"),
            },
            prose: {
                above: textTop(prose, "prose above"),
                directive: textTop(prose, "{% if"),
                below: textTop(prose, "prose below"),
            },
            inline: { before: textTop(inline, "Inline"), directive: textTop(inline, "{{ site"), after: textTop(inline, "stays"), joined: textTop(inline, "joined") },
        };
    });
    const { shots, prose, inline } = tops;
    check("the probe found every piece it measures",
        [shots.open, shots.firstImg, shots.close, prose.above, prose.directive, prose.below, inline.before, inline.directive, inline.joined]
            .every((v) => typeof v === "number"), JSON.stringify(tops));
    check("a paired shortcode's opener sits on its own line, above the images",
        shots.open < shots.firstImg, JSON.stringify(shots));
    check("and its closer sits on its own line, below them",
        shots.close >= shots.lastImgBottom - 2, JSON.stringify(shots));
    check("a directive alone on its line between two lines of prose keeps that line",
        prose.above < prose.directive && prose.directive < prose.below, JSON.stringify(prose));
    check("a directive inside a sentence stays on the sentence's line",
        // Within a few pixels: the directive's smaller face sits a little
        // lower in the same line box.
        Math.abs(inline.before - inline.directive) < 6 && inline.before === inline.after, JSON.stringify(inline));
    // The control: this paragraph's soft break borders no directive-only
    // line, so it must still draw as a space. Without it, a build that drew
    // every soft break as a line break would pass the arms above.
    check("an ordinary soft break still joins its two lines",
        inline.after === inline.joined, JSON.stringify(inline));

    const atom = await page.evaluate(() => {
        const el = document.querySelector(".html-inline[data-tpl-source]");
        return el ? getComputedStyle(el, "::before").content : null;
    });
    check("an html tag inside a shortcode shows its bytes, so the shortcode reads whole",
        atom === "\"<figure src=\\\"a.png\\\">\"", JSON.stringify(atom));

    // ── Typing across a break drawn as a block. The caret after a
    // zero-height block is the arrangement an engine could misplace. Each
    // gesture clicks the text it means by its own coordinates: clicking the
    // paragraph would land on its middle line, which is the directive. ──────
    /** Click just inside the start or the end of the first text matching `needle`. */
    const clickText = async (needle, atEnd) => {
        const at = await page.evaluate(({ needle, atEnd }) => {
            const walker = document.createTreeWalker(document.querySelector(".ProseMirror"), NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const i = n.data.indexOf(needle);
                if (i < 0) continue;
                const r = document.createRange();
                r.setStart(n, i);
                r.setEnd(n, i + needle.length);
                const box = r.getBoundingClientRect();
                return { x: atEnd ? box.right - 1 : box.left + 1, y: box.top + box.height / 2 };
            }
            return null;
        }, { needle, atEnd });
        if (at) await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(150);
        return at !== null;
    };
    const lastPosted = async () => {
        await page.waitForTimeout(600);
        return page.evaluate(() => {
            const posted = window.__posted.filter((m) => m.type === "update").map((m) => m.content);
            return posted[posted.length - 1] ?? "";
        });
    };
    const around = (text) => JSON.stringify(text.slice(text.indexOf("prose above"), text.indexOf("prose above") + 60));

    const reachedBelow = await clickText("prose below", false);
    await page.keyboard.press("Home");
    await page.keyboard.type("Z", { delay: 40 });
    const afterZ = await lastPosted();
    check("a character typed at the start of the line after a directive lands there",
        reachedBelow && afterZ.includes("%}\nZprose below"), around(afterZ));

    const reachedDirective = await clickText("{% if page.draft %}", true);
    await page.keyboard.press("End");
    await page.keyboard.type("!", { delay: 40 });
    const afterBang = await lastPosted();
    check("a character typed at the end of the directive's line lands at the end of the directive",
        reachedDirective && afterBang.includes("{% if page.draft %}!\nZprose below"), around(afterBang));
    check("the rest of the document serializes untouched",
        afterBang.includes("{{< shots >}}\n![A box](") && afterBang.includes("{{<figure src=\"a.png\">}}"),
        JSON.stringify(afterBang.slice(0, 120)));
}
