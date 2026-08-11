/**
 * Vertical rhythm of the content column, measured as a reader sees it.
 *
 * The scale in style.css says every block owns its BOTTOM gap, so the space
 * between two blocks is one value rather than an additive mix. The checks here
 * assert that as an invariant over the whole document — every step of a given
 * kind is the same step — rather than comparing each pair against a number,
 * which would only confirm what the author already believed and would need
 * editing every time the scale is tuned.
 *
 * Measured between TEXT LINES, not boxes: half of the rhythm lives in padding
 * (paragraphs space with padding so their click area includes the gap), so a
 * border-box comparison reports zero for the very gaps under test. jsdom has no
 * layout engine at all, which is why this lives here.
 */

/**
 * Injected into the page: the bottom of an element's last text line and the top
 * of its first, ignoring chrome. Top-level paragraphs carry a hover-revealed
 * gutter widget whose rect is taller than the line box and would otherwise
 * stand in for it, so only real text nodes are measured.
 */
const HELPERS = `
    const textRects = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const texts = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.nodeValue.trim() && !n.parentElement.closest("[contenteditable=false]")) texts.push(n);
        }
        if (!texts.length) return [];
        const range = document.createRange();
        range.setStart(texts[0], 0);
        range.setEnd(texts[texts.length - 1], texts[texts.length - 1].nodeValue.length);
        return [...range.getClientRects()].filter((r) => r.height > 0);
    };
    const firstLine = (el) => textRects(el)[0];
    const lastLine = (el) => { const r = textRects(el); return r[r.length - 1]; };
    // The step between two text blocks, in em of the content column.
    const em = parseFloat(getComputedStyle(document.querySelector("#editor")).fontSize);
    const step = (a, b) => {
        const A = lastLine(a), B = firstLine(b);
        return A && B ? +((B.top - A.bottom) / em).toFixed(3) : null;
    };
    const steps = (els) => els.slice(1).map((el, i) => step(els[i], el));
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)];
`;

/** All values equal within half a pixel of each other (14px em → 0.036em). */
function allEqual(values) {
    return values.length > 0
        && values.every((v) => typeof v === "number")
        && Math.max(...values) - Math.min(...values) <= 0.036;
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror ul li", { timeout: 10000 });
    await page.waitForTimeout(300);

    // ── Inside a list, every step is the same step ──────────────────────────
    // The one the user reported: descending into a nested list cost the
    // parent paragraph's gap PLUS the nested list's own top margin, so a child
    // item sat twice as far below its parent as a sibling item did. Flattening
    // every text block in the tree into document order turns "sibling, nested,
    // stacked paragraph, quote inside an item" into a single list of adjacent
    // pairs, and the invariant is that they are all equal — which holds however
    // deep the nesting goes and needs no per-construct case.
    const bullets = await page.evaluate(`(() => {
        ${HELPERS}
        // The FIRST top-level bullet list: the document holds a task list too,
        // and a document-wide descendant query would score the jump between
        // the two lists as if it were a step inside one.
        const list = all(".milkdown .ProseMirror > ul")[0];
        // Every text block in the list, in reading order. A pair is scored only
        // when both sides are bare paragraphs: a quote brings its own inner
        // padding along (checked separately below), so including it would
        // measure the box rather than the rhythm.
        const blocks = [...list.querySelectorAll("li > :is(p, blockquote)")];
        const scored = blocks.slice(1).map((el, i) =>
            el.tagName === "P" && blocks[i].tagName === "P" ? step(blocks[i], el) : null);
        return {
            steps: scored.filter((s) => s !== null),
            count: blocks.length,
            depth: list.querySelectorAll("ul ul").length,
        };
    })()`);
    check("fixture exercises three levels of bullet nesting",
        bullets.depth >= 1 && bullets.count >= 8, `blocks=${bullets.count} deepLists=${bullets.depth}`);
    check("every step inside the bullet list is the same step",
        allEqual(bullets.steps), JSON.stringify(bullets.steps));

    const ordered = await page.evaluate(`(() => {
        ${HELPERS}
        const blocks = all(".milkdown .ProseMirror > ol li > p");
        return { steps: steps(blocks), count: blocks.length };
    })()`);
    check("every step inside the ordered list is the same step",
        ordered.count >= 5 && allEqual(ordered.steps), JSON.stringify(ordered.steps));

    check("bullet and ordered lists step by the same amount",
        allEqual([...bullets.steps, ...ordered.steps]),
        `bullet=${bullets.steps[0]} ordered=${ordered.steps[0]}`);

    // A quote keeps its OWN inner padding wherever it sits, so its steps are
    // wider than a bare one — but they must stay equal on both sides, and equal
    // to each other inside a list item just as at top level. That is the line
    // between "the container's gap", which the list tightens, and "the box's
    // own air", which is the box's business.
    const quoteInItem = await page.evaluate(`(() => {
        ${HELPERS}
        const bq = q(".milkdown .ProseMirror > ul li > blockquote");
        const before = bq.previousElementSibling;
        const after = bq.closest("li").nextElementSibling.querySelector("p");
        return { into: step(before, bq), outOf: step(bq, after) };
    })()`);
    check("a quote inside a list item is spaced symmetrically",
        allEqual([quoteInItem.into, quoteInItem.outOf]),
        `in=${quoteInItem.into} out=${quoteInItem.outOf}`);
    check("…and wider than a bare list step, by its own padding",
        quoteInItem.into > bullets.steps[0],
        `quote=${quoteInItem.into} bare=${bullets.steps[0]}`);

    // The other half of that line, and the one an inherited custom property
    // silently breaks: the prose INSIDE the quote is prose, so its paragraphs
    // step the way paragraphs do wherever the quote happens to sit. Tightening
    // a list must not reach in and re-space the box's contents.
    const quoteProse = await page.evaluate(`(() => {
        ${HELPERS}
        const inner = (bq) => [...bq.querySelectorAll(":scope > p")];
        const top = inner(q(".milkdown .ProseMirror > blockquote"));
        const item = inner(q(".milkdown .ProseMirror > ul li > blockquote"));
        return {
            top: top.length >= 2 ? step(top[0], top[1]) : null,
            item: item.length >= 2 ? step(item[0], item[1]) : null,
        };
    })()`);
    check("a quote's own paragraphs step alike at top level and inside an item",
        quoteProse.top !== null && allEqual([quoteProse.top, quoteProse.item]),
        JSON.stringify(quoteProse));

    // Task items are ordinary items wearing a checkbox, so they take the list
    // step too — including into a nested task.
    const tasks = await page.evaluate(`(() => {
        ${HELPERS}
        const list = all(".milkdown .ProseMirror > ul")
            .find((l) => l.querySelector('li[data-item-type="task"]'));
        if (!list) return { steps: [], count: 0 };
        const ps = [...list.querySelectorAll("li > p")];
        return { steps: steps(ps), count: ps.length };
    })()`);
    check("every step inside a task list is the same step, nested or not",
        tasks.count >= 4 && allEqual([...tasks.steps, ...bullets.steps]),
        `count=${tasks.count} steps=${JSON.stringify(tasks.steps)}`);

    // A list step is TIGHTER than a top-level flow step — the whole point of a
    // separate token. Without this an "all equal" suite would pass just as well
    // if the two collapsed into one value.
    const flow = await page.evaluate(`(() => {
        ${HELPERS}
        const ps = all(".milkdown .ProseMirror > p");
        const list = all(".milkdown .ProseMirror > ul")[0];
        const bq = q(".milkdown .ProseMirror > blockquote");
        return {
            paraToPara: step(ps[0], ps[1]),
            // Entering and leaving a list must cost the same as any other flow
            // step: the list owns its bottom gap, the paragraph before it owns
            // the one above.
            paraToList: step(ps[1], list.querySelector("li > p")),
            listToPara: step([...list.querySelectorAll("li > p")].pop(), ps[2]),
            paraToQuote: step(bq.previousElementSibling, bq),
            quoteToPara: step(bq, bq.nextElementSibling),
        };
    })()`);
    check("a list step is tighter than a paragraph step",
        bullets.steps[0] < flow.paraToPara,
        `list=${bullets.steps[0]} flow=${flow.paraToPara}`);
    check("entering and leaving a list costs one flow step, like any other block",
        allEqual([flow.paraToPara, flow.paraToList, flow.listToPara]),
        JSON.stringify(flow));
    check("a top-level quote's steps are symmetric",
        allEqual([flow.paraToQuote, flow.quoteToPara]),
        `in=${flow.paraToQuote} out=${flow.quoteToPara}`);

    // ── Headings ────────────────────────────────────────────────────────────
    // h1 wore a bottom rule, and it was the one heading that had to space
    // differently to carry it: a full flow gap below, to separate the line from
    // the section it opened. Without the rule it rejoins the shared rhythm, so
    // the assertion is that its spacing is h2's — in em, since the two differ
    // in font size by design.
    const headings = await page.evaluate(`(() => {
        ${HELPERS}
        const rel = (sel) => {
            const el = q(sel);
            const cs = getComputedStyle(el);
            const own = parseFloat(cs.fontSize);
            return {
                border: cs.borderBottomWidth,
                padTop: +(parseFloat(cs.paddingTop) / own).toFixed(3),
                padBottom: +(parseFloat(cs.paddingBottom) / own).toFixed(3),
                marginBottom: cs.marginBottom,
            };
        };
        return { h1: rel(".milkdown .ProseMirror h1"), h2: rel(".milkdown .ProseMirror h2") };
    })()`);
    check("h1 has no bottom rule", headings.h1.border === "0px", `border=${headings.h1.border}`);
    check("h1 keeps the shared heading rhythm",
        headings.h1.padTop === headings.h2.padTop
        && headings.h1.padBottom === headings.h2.padBottom
        && headings.h1.marginBottom === "0px"
        && headings.h2.marginBottom === "0px",
        JSON.stringify(headings));
}
