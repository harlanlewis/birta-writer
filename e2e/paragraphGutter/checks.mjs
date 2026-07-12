/**
 * Paragraph "P" gutter — real-browser truths (hover reveal is CSS :hover, which
 * jsdom can't compute):
 *   - the marker is invisible (and unclickable) until the paragraph is hovered,
 *   - hovering the paragraph shows a subtle P; hovering the marker itself brings
 *     it to the headings' full-contrast treatment,
 *   - clicking it opens the same P/H1–H6 menu, and picking H2 promotes the
 *     paragraph (serialized as `## …`),
 *   - list/quote paragraphs get no marker (top-level only).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".heading-fold-marker--paragraph", { timeout: 10000 });
    // The fixture's code block pulls the lazy grammar chunk and re-highlights
    // asynchronously; those late DOM mutations clear Chromium's hover chain
    // out from under a synthetic mouse position. Wait for the DETERMINISTIC
    // completion signal — refractor's token spans appearing in the code
    // block — then two frames for the render to settle (a fixed sleep here
    // was machine-speed roulette).
    await page.waitForFunction(
        () => document.querySelector("pre code .token, .code-block-wrapper code .token"),
        { timeout: 10000 },
    );
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    const pMarker = ".ProseMirror > p .heading-fold-marker--paragraph";
    const opacity = () => page.$eval(pMarker, (el) => getComputedStyle(el).opacity);


    // ── 1. P markers on the two top-level TEXT paragraphs only. The fixture
    // also carries an image-only line and a raw-html line — both parse as
    // top-level paragraphs but must NOT get the P marker (MAR-79). ──
    const markerCount = await page.$$eval(".heading-fold-marker--paragraph", (els) => els.length);
    check("only the top-level text paragraphs get P markers (not image/html blocks)", markerCount === 2, `count=${markerCount}`);
    const inListOrQuote = await page.$$eval(
        "li .heading-fold-marker--paragraph, blockquote .heading-fold-marker--paragraph",
        (els) => els.length,
    );
    check("no P marker inside list or quote", inListOrQuote === 0);

    // ── 2. Idle: invisible and click-inert ──
    await page.mouse.move(700, 600); // park the pointer away from any paragraph
    await page.waitForTimeout(100);
    check("idle: P marker invisible", (await opacity()) === "0", `opacity=${await opacity()}`);

    // ── 3. Hovering the paragraph reveals a subtle P ──
    const paraBox = await page.$eval(".ProseMirror > p", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(paraBox.x, paraBox.y);
    await page.waitForTimeout(150);
    // Async renders after the move (the code block's lazy grammar chunk)
    // clear Chromium's hover chain until the next real input — jiggle to
    // re-establish it. A human's continuous motion does this for free.
    await page.mouse.move(paraBox.x + 1, paraBox.y);
    await page.waitForTimeout(50);
    const subtle = parseFloat(await opacity());
    check("paragraph hover: P at the heading markers' resting contrast", subtle > 0.5 && subtle < 0.9, `opacity=${subtle}`);

    // ── 4. Mousing from the text TO the marker keeps it alive (gap bridge) ──
    // The regression: leaving the paragraph's text box dropped :hover and the
    // marker vanished before it could be clicked. Travel in small steps.
    const markerBox = await page.$eval(pMarker, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const paraLeft = await page.$eval(".ProseMirror > p", (el) => el.getBoundingClientRect().x);
    await page.mouse.move(paraLeft + 4, markerBox.y); // at the text's left edge
    await page.waitForTimeout(80);
    await page.mouse.move(markerBox.x, markerBox.y, { steps: 20 }); // travel the gap
    await page.waitForTimeout(150);
    const arrived = parseFloat(await opacity());
    check("traveling text → marker keeps it visible (full contrast on arrival)", arrived === 1, `opacity=${arrived}`);

    // ── 4b. Generous hit target, glyph unmoved ──
    // The button's border box (hover background + click target) is padded well
    // beyond the glyph, while negative margins keep the glyph's rendered
    // position where the bare text sat: 2px inside the gutter's right edge.
    const markerGeometry = (sel) =>
        page.$eval(sel, (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            const glyph = range.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            const gutter = el.parentElement.getBoundingClientRect();
            return {
                padX: box.width - glyph.width,
                padY: box.height - glyph.height,
                glyphInsetFromGutterRight: gutter.right - glyph.right,
            };
        });
    const pGeom = await markerGeometry(pMarker);
    check("P marker box is padded beyond the glyph", pGeom.padX >= 10 && pGeom.padY >= 8,
        `padX=${pGeom.padX.toFixed(1)} padY=${pGeom.padY.toFixed(1)}`);
    check("P glyph stays 2px inside the gutter's right edge",
        Math.abs(pGeom.glyphInsetFromGutterRight - 2) <= 1.5,
        `inset=${pGeom.glyphInsetFromGutterRight.toFixed(1)}`);

    // The marker is hovered right now (step 4 landed on it) — the tooltip is
    // visible and must teach both verbs (menu click + drag).
    const tipText = await page.$eval(".custom-tooltip", (el) => el.textContent);
    check("P marker tooltip teaches click and drag", tipText === "Click for options · Drag to move",
        `tooltip=${tipText}`);

    // ── 4c. Heading hash marker: same enlargement, chevron untouched ──
    const hMarker = ".ProseMirror h2 .heading-fold-marker:not(.heading-fold-marker--paragraph)";
    const hGeom = await markerGeometry(hMarker);
    check("## marker box is padded beyond the glyph", hGeom.padX >= 10 && hGeom.padY >= 8,
        `padX=${hGeom.padX.toFixed(1)} padY=${hGeom.padY.toFixed(1)}`);
    check("## glyph stays 2px inside the gutter's right edge",
        Math.abs(hGeom.glyphInsetFromGutterRight - 2) <= 1.5,
        `inset=${hGeom.glyphInsetFromGutterRight.toFixed(1)}`);
    const chevronGap = await page.$eval(hMarker, (el) => {
        const chevron = el.parentElement.querySelector(".heading-fold-toggle");
        if (!chevron) return null;
        return el.getBoundingClientRect().left - chevron.getBoundingClientRect().right;
    });
    check("## marker's enlarged box does not overlap the fold chevron",
        chevronGap !== null && chevronGap >= -0.5, `gap=${chevronGap?.toFixed(1)}`);

    // ── 4d. Every top-level block type carries its icon marker ──
    // Fixture order: text P, list item, quote, image, html, code — each
    // showing its slash-menu row's SVG icon (data-pill names the type).
    const markers = await page.$$eval(".heading-fold-marker--block", (els) =>
        els.map((el) => ({ pill: el.dataset.pill, svg: !!el.querySelector("svg") })));
    check("block icon markers cover every fixture block type",
        JSON.stringify(markers.map((m) => m.pill)) === JSON.stringify([
            "Paragraph", "List item", "Blockquote", "Image", "HTML",
            "Code Block", "Task", "Mermaid Diagram", "Paragraph", "Footnote",
            "Table", "Callout", "Callout", "Directive",
            "Callout", "Callout", "Blockquote", "Code Block", "Code Block", "Table",
            "Blockquote", "Heading", "Blockquote",
        // Nested headings carry an H1-H6 text badge instead of an SVG icon.
        ]) && markers.every((m) => m.svg || m.pill === "Heading"),
        `markers=${JSON.stringify(markers)}`);

    // Nested children (a callout in a callout, a code block in a callout,
    // a heading and a quote inside a blockquote) are grabbable units: child
    // markers exist and reveal on THEIR hover.
    const nested = await page.evaluate(() => {
        const kids = [...document.querySelectorAll(".block-gutter-host--child")];
        return kids.map((el) => ({
            pill: el.querySelector(".heading-fold-marker")?.dataset?.pill ?? null,
            x: Math.round(el.querySelector(".heading-fold-marker")?.getBoundingClientRect().x ?? -1),
        }));
    });
    check("nested container children carry their own markers",
        nested.length === 7 && nested.every((n) => n.pill !== null), JSON.stringify(nested));
    const innerCallout = await page.evaluate(() => {
        const el = [...document.querySelectorAll(".block-gutter-host--child")]
            .find((k) => k.classList.contains("callout"));
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 12 };
    });
    check("inner callout found", innerCallout !== null);
    await page.mouse.move(innerCallout.x, innerCallout.y);
    await page.waitForTimeout(150);
    const innerReveal = await page.evaluate(() => {
        const el = [...document.querySelectorAll(".block-gutter-host--child")]
            .find((k) => k.classList.contains("callout"));
        const m = el?.querySelector(".heading-fold-marker");
        const outer = el?.closest(".callout:not(.block-gutter-host--child)")
            ?.querySelector(":scope .heading-fold-marker");
        return {
            inner: m ? Number(getComputedStyle(m).opacity) : -1,
        };
    });
    check("hovering the inner callout reveals ITS marker",
        innerReveal.inner > 0.5, JSON.stringify(innerReveal));

    // A NodeView block TWO containers deep (code in callout in callout) must
    // reveal its own marker on hover too — the old reveal rule capped the
    // descendant variant at two child levels, leaving an invisible but
    // active button in the margin.
    const deepCode = await page.evaluate(() => {
        const el = document.querySelector(".callout .callout .code-block-wrapper");
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + Math.min(12, r.height / 2) };
    });
    check("depth-2 code block found", deepCode !== null);
    await page.mouse.move(deepCode.x, deepCode.y);
    await page.waitForTimeout(150);
    await page.mouse.move(deepCode.x + 1, deepCode.y);
    await page.waitForTimeout(80);
    const deepReveal = await page.evaluate(() => {
        const el = document.querySelector(".callout .callout .code-block-wrapper");
        const m = el?.querySelector(".heading-fold-marker");
        const parentOwn = el?.closest(".callout.block-gutter-host--child")
            ?.querySelector(":scope > .callout-body > .heading-fold-gutter .heading-fold-marker");
        return {
            own: m ? Number(getComputedStyle(m).opacity) : -1,
            parent: parentOwn ? Number(getComputedStyle(parentOwn).opacity) : -1,
        };
    });
    check("hovering a depth-2 NodeView block reveals ITS marker (parent stays quiet)",
        deepReveal.own > 0.5 && deepReveal.parent < 0.1, JSON.stringify(deepReveal));

    // Hovering the OUTER callout's title must reveal only the outer marker
    // — not pop the whole nested column at once.
    const outerTitle = await page.evaluate(() => {
        const outer = [...document.querySelectorAll(".ProseMirror > .callout")]
            .find((c) => c.textContent.includes("Outer"));
        outer.scrollIntoView({ block: "center" });
        const r = outer.querySelector(".callout-title").getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2 };
    });
    await page.mouse.move(outerTitle.x, outerTitle.y);
    await page.waitForTimeout(150);
    const outerReveal = await page.evaluate(() => {
        const outer = [...document.querySelectorAll(".ProseMirror > .callout")]
            .find((c) => c.textContent.includes("Outer"));
        const own = outer.querySelector(":scope > .callout-body > .heading-fold-gutter .heading-fold-marker");
        const childMarkers = [...outer.querySelectorAll(".block-gutter-host--child .heading-fold-marker")];
        return {
            own: own ? Number(getComputedStyle(own).opacity) : -1,
            children: childMarkers.map((m) => Number(getComputedStyle(m).opacity)),
        };
    });
    check("outer-callout hover reveals only its OWN marker (children stay quiet)",
        outerReveal.own > 0.5 && outerReveal.children.every((o) => o < 0.1),
        JSON.stringify(outerReveal));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(120);

    // NodeView blocks nest the gutter below wrapper chrome — hovering the
    // block BODY must still reveal the marker (descendant reveal variant).
    for (const [sel, name] of [
        [".ProseMirror .mw-table", "table"],
        [".ProseMirror .footnote-def", "footnote"],
        [".ProseMirror .callout:not(.collapsed)", "callout"],
        [".ProseMirror .callout.collapsed", "FOLDED callout"],
        [".ProseMirror .container-directive", "directive"],
    ]) {
        const pt = await page.$eval(sel, (el) => {
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + Math.min(12, r.height / 2) };
        });
        await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(150);
        const revealed = await page.$eval(sel, (el) => {
            const m = el.querySelector(".heading-fold-marker");
            return m ? Number(getComputedStyle(m).opacity) : -1;
        });
        check(`${name} marker reveals when hovering the block body`,
            revealed > 0.3, `opacity=${revealed}`);
    }
    // Restore the viewport the earlier checks were measured against.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0);
    await page.waitForTimeout(120);

    // Marker geometry: every block marker sits in ONE column and aligns
    // with its block's first VISIBLE line (wrapper blocks compensate for
    // their padding/header chrome — the icon must never ride the corner).
    const geometry = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelector(".ProseMirror").children) {
            const m = el.querySelector(".heading-fold-marker--block");
            // Item markers live in their own per-flavor columns — this check
            // is about TOP-LEVEL block markers only.
            if (!m || m.closest(".block-gutter-host--item")) continue;
            const headed = el.querySelector(".callout-title, .directive-header, .code-block-header");
            const probe = headed ?? el.querySelector("p, td, code, .footnote-def-content p") ?? el;
            const pr = probe.getBoundingClientRect();
            const mr = m.getBoundingClientRect();
            const lineCenter = pr.y + Math.min(12, pr.height / 2);
            out.push({ pill: m.dataset.pill,
                       dy: Math.round((mr.y + mr.height / 2 - lineCenter) * 10) / 10,
                       cx: Math.round((mr.x + mr.width / 2) * 10) / 10 });
        }
        return out;
    });
    check("every marker aligns with its block's first line (±3px)",
        geometry.length >= 8 && geometry.every((g) => Math.abs(g.dy) <= 3),
        JSON.stringify(geometry.filter((g) => Math.abs(g.dy) > 3)));
    const topLevelXs = geometry.map((g) => g.cx);
    check("top-level markers share one column (±1px)",
        Math.max(...topLevelXs) - Math.min(...topLevelXs) <= 1.2, JSON.stringify(geometry));

    // NESTED markers must sit on their block's first visible line too — the
    // regression: the flat --child `top: 0` ignored a nested heading's own
    // padding-top (the H1 badge rode a full line-height above its text) and
    // a nested quote's padded body. NodeView children (callout, code block,
    // table) anchor their gutter inside their body and keep the per-wrapper
    // calibration — held to the same band here so that stays true. And the
    // markers must sit CLEAR of every ancestor container's border bar (the
    // other regression: a callout-in-callout marker straddled the parent's
    // accent bar). Both invariants are asserted at 100% AND 200% content
    // font scale: the paddings the calibrations compensate are em-based, so
    // px-constant calibrations drift off the line as the font grows.
    const measureNested = () => page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll(".block-gutter-host--child")) {
            const m = el.querySelector(".heading-fold-marker--block");
            if (!m) continue;
            const mr = m.getBoundingClientRect();
            let lineCenter;
            if (/^H[1-6]$/.test(el.tagName)) {
                // The badge belongs on the heading's TEXT line, which its
                // padding-top pushes well below the border-box top.
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                let tn, textRect = null;
                while ((tn = walker.nextNode())) {
                    if (tn.textContent.trim() && !tn.parentElement.closest(".heading-fold-gutter")) {
                        const range = document.createRange();
                        range.selectNodeContents(tn);
                        textRect = range.getBoundingClientRect();
                        break;
                    }
                }
                if (!textRect) continue;
                lineCenter = textRect.y + textRect.height / 2;
            } else {
                const em = parseFloat(getComputedStyle(document.getElementById("editor")).fontSize);
                const headed = el.querySelector(".callout-title, .directive-header, .code-block-header");
                const probe = headed ?? el.querySelector("p, td") ?? el;
                const pr = probe.getBoundingClientRect();
                lineCenter = pr.y + Math.min(0.86 * em, pr.height / 2);
            }
            let clearance = Infinity;
            for (let anc = el.parentElement; anc && !anc.classList.contains("ProseMirror"); anc = anc.parentElement) {
                if (anc.matches(".callout, .container-directive, blockquote, .mw-table")) {
                    clearance = Math.min(clearance, Math.round((anc.getBoundingClientRect().left - mr.right) * 10) / 10);
                }
            }
            out.push({ pill: m.dataset.pill, tag: el.tagName, clearance,
                       dy: Math.round((mr.y + mr.height / 2 - lineCenter) * 10) / 10 });
        }
        return out;
    });
    for (const scale of [1, 2]) {
        await page.evaluate((sc) => {
            document.documentElement.style.setProperty("--content-font-scale", String(sc));
        }, scale);
        await page.evaluate(
            () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const tol = 3 * scale; // the line box itself doubles at 200%
        const nestedGeometry = await measureNested();
        check(`every nested marker aligns with its block's first line at ${scale * 100}% (±${tol}px)`,
            nestedGeometry.length === 7 && nestedGeometry.every((g) => Math.abs(g.dy) <= tol),
            JSON.stringify(nestedGeometry.filter((g) => Math.abs(g.dy) > tol)));
        check(`every nested marker clears its ancestor containers' border bars at ${scale * 100}% (≥2px)`,
            nestedGeometry.length === 7 && nestedGeometry.every((g) => g.clearance >= 2),
            JSON.stringify(nestedGeometry.filter((g) => g.clearance < 2)));
    }
    await page.evaluate(() => {
        document.documentElement.style.removeProperty("--content-font-scale");
    });
    await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    // Block-range selection must not double-paint: the native ::selection
    // is suppressed (hideselection wins the cascade) while the tint shows.
    const firstP = await page.$eval(".ProseMirror > p", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + 8 };
    });
    await page.mouse.click(firstP.x, firstP.y);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);
    const selectionPaint = await page.evaluate(() => {
        const root = document.querySelector(".ProseMirror");
        return {
            hide: root.classList.contains("ProseMirror-hideselection"),
            bg: getComputedStyle(root.querySelector("p"), "::selection").backgroundColor,
            tint: getComputedStyle(document.querySelector(".block-range-tint")).display !== "none",
        };
    });
    check("block selection: native paint suppressed, tint shown",
        selectionPaint.hide && selectionPaint.bg === "rgba(0, 0, 0, 0)" && selectionPaint.tint,
        JSON.stringify(selectionPaint));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);

    // Mermaid boots into PREVIEW mode (code area collapsed, not
    // display:none-d) — its gutter marker must still be measurable there.
    const mermaidMarker = await page.evaluate(() => {
        const el = [...document.querySelectorAll(".heading-fold-marker--block")]
            .find((m) => m.dataset.pill === "Mermaid Diagram");
        const r = el?.getBoundingClientRect();
        return r ? { x: Math.round(r.x), h: Math.round(r.height) } : null;
    });
    check("mermaid marker measurable while the diagram previews",
        mermaidMarker !== null && mermaidMarker.h > 0, JSON.stringify(mermaidMarker));

    // Item markers sit at per-flavor offsets (tuned to the ::marker ink —
    // bullet dot vs "1." vs checkbox), but every one must stay inside the
    // gutter, clear of its content, within a tight band: a task li's box
    // starts ~21px left of a bullet's, and an unadjusted shared offset once
    // pushed its marker 21px out of column.
    const itemMarkers = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror li")].flatMap((li) => {
            const m = li.querySelector(":scope > .heading-fold-gutter > .heading-fold-marker");
            const c = li.querySelector(":scope > p, :scope > div");
            if (!m || !c) return [];
            return [{
                task: li.getAttribute("data-item-type") === "task",
                gap: Math.round(c.getBoundingClientRect().x - m.getBoundingClientRect().right),
            }];
        }));
    check("every item marker sits in the gutter within the tuned band",
        itemMarkers.length >= 2 && itemMarkers.every(({ gap }) => gap >= 18 && gap <= 40),
        `gaps=${JSON.stringify(itemMarkers)}`);

    // Each glyph marker must sit in the LEFT GUTTER of its own block — the
    // in-NodeView anchoring (code block) is the fragile part. Hover the block
    // first so the marker is revealed where geometry is measured.
    for (const [sel, name] of [
        // Per-item markers (MAR-86): the list's marker belongs to its ITEM.
        [".ProseMirror > ul li", "list item"],
        [".ProseMirror > blockquote", "quote"],
        [".ProseMirror > .code-block-wrapper, .ProseMirror > pre", "code"],
    ]) {
        const geom = await page.$eval(sel, (host) => {
            const m = host.querySelector(".heading-fold-marker--block");
            if (!m) return null;
            const hostRect = host.getBoundingClientRect();
            const rect = m.getBoundingClientRect();
            return {
                leftOfBlock: rect.right <= hostRect.left + 2,
                withinBlockY: rect.top >= hostRect.top - 4 && rect.bottom <= hostRect.bottom + 4,
            };
        }).catch(() => null);
        check(`${name} marker sits in its block's left gutter`,
            geom !== null && geom.leftOfBlock && geom.withinBlockY,
            JSON.stringify(geom));
    }

    // Hover the list: its marker reveals at resting contrast.
    const listBox = await page.$eval(".ProseMirror > ul", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(listBox.x, listBox.y);
    await page.waitForTimeout(150);
    await page.mouse.move(listBox.x + 1, listBox.y); // hover-chain jiggle (see check 3)
    await page.waitForTimeout(50);
    const listMarkerOpacity = await page.$eval(
        ".ProseMirror > ul .heading-fold-marker--block",
        (el) => parseFloat(getComputedStyle(el).opacity),
    );
    check("hovering a list reveals its - marker", listMarkerOpacity > 0.4,
        `opacity=${listMarkerOpacity}`);

    // ── Resting modes (`markdownWysiwyg.gutterMarkers`): the extension maps
    // the setting to a body class (none → gutter-rest-none, all →
    // gutter-rest-all; default headings → neither), so toggling the classes
    // here exercises exactly what a settings change does. ──
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(0, 0); // park: nothing content-hovered
    await page.waitForTimeout(120);
    const pRest = () => page.$eval(pMarker, (el) => parseFloat(getComputedStyle(el).opacity));
    const hBadgeSel = ".ProseMirror > h2 > .heading-fold-gutter .heading-fold-marker";
    const hRest = () => page.$eval(hBadgeSel, (el) => parseFloat(getComputedStyle(el).opacity));
    // Markers transition opacity over 120ms — every class toggle below must
    // outwait the transition before sampling the computed value.
    const setBodyClasses = async (add, remove = []) => {
        await page.evaluate(({ add, remove }) => {
            document.body.classList.remove(...remove);
            document.body.classList.add(...add);
        }, { add, remove });
        await page.waitForTimeout(200);
    };

    check("default mode: heading badge rests visible", (await hRest()) > 0.5, `opacity=${await hRest()}`);
    check("default mode: block marker rests hidden", (await pRest()) === 0, `opacity=${await pRest()}`);

    await setBodyClasses(["gutter-rest-all"]);
    check("rest-all: block marker rests at the badges' contrast",
        Math.abs((await pRest()) - 0.7) < 0.05, `opacity=${await pRest()}`);
    check("rest-all: heading badge unchanged", (await hRest()) > 0.5, `opacity=${await hRest()}`);
    // Typing quiet must NOT hide at-rest markers in this mode — they are
    // ambient chrome like the badges, not a hover reveal to suppress.
    await setBodyClasses(["gutter-quiet"]);
    check("rest-all: quiet-while-typing leaves at-rest markers visible",
        (await pRest()) > 0.5, `opacity=${await pRest()}`);
    await setBodyClasses(["gutter-rest-none"], ["gutter-quiet", "gutter-rest-all"]);
    check("rest-none: heading badge rests hidden", (await hRest()) === 0, `opacity=${await hRest()}`);
    check("rest-none: block marker rests hidden", (await pRest()) === 0, `opacity=${await pRest()}`);
    // Hovering the heading reveals its badge at resting contrast…
    const h2Box = await page.$eval(".ProseMirror > h2", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.x };
    });
    await page.mouse.move(h2Box.x, h2Box.y);
    await page.waitForTimeout(150);
    await page.mouse.move(h2Box.x + 1, h2Box.y); // hover-chain jiggle (see check 3)
    await page.waitForTimeout(50);
    const revealedBadge = await hRest();
    check("rest-none: hovering the heading reveals its badge at resting contrast",
        revealedBadge > 0.5 && revealedBadge < 0.9, `opacity=${revealedBadge}`);
    // …and the badge's own hover still brings full contrast (its state rules
    // are excluded from the mode rules, not out-specified).
    const badgeBox = await page.$eval(hBadgeSel, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(h2Box.left + 4, badgeBox.y);
    await page.waitForTimeout(80);
    await page.mouse.move(badgeBox.x, badgeBox.y, { steps: 20 });
    await page.waitForTimeout(150);
    check("rest-none: hovering the badge itself gives full contrast",
        (await hRest()) === 1, `opacity=${await hRest()}`);
    // A COLLAPSED heading's badge must stay visible even in this mode — the
    // collapsed-state rule outranks the hide rule, so folded content stays
    // discoverable. Collapse via the chevron (hovered right now), park the
    // pointer, measure, then unfold (the chevron stays visible while
    // collapsed, so no re-hover is needed to click it again).
    const chevronBox = await page.$eval(".ProseMirror > h2 > .heading-fold-gutter .heading-fold-toggle", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(chevronBox.x, chevronBox.y);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(250);
    const collapsedState = await page.$eval(".ProseMirror > h2", (el) => ({
        collapsed: el.classList.contains("heading-fold-heading--collapsed"),
        badge: parseFloat(getComputedStyle(el.querySelector(".heading-fold-marker")).opacity),
    }));
    check("rest-none: a collapsed heading's badge stays visible at rest",
        collapsedState.collapsed && collapsedState.badge >= 0.7,
        JSON.stringify(collapsedState));
    await page.mouse.click(chevronBox.x, chevronBox.y); // unfold
    await page.waitForTimeout(200);
    const refolded = await page.$eval(".ProseMirror > h2", (el) =>
        el.classList.contains("heading-fold-heading--collapsed"));
    check("rest-none: the heading unfolds again", !refolded, `collapsed=${refolded}`);
    // In this mode the badge IS a hover reveal — typing quiet suppresses it.
    await page.mouse.move(h2Box.x, h2Box.y);
    await page.waitForTimeout(100);
    await setBodyClasses(["gutter-quiet"]);
    check("rest-none: quiet-while-typing suppresses the heading-hover reveal",
        (await hRest()) === 0, `opacity=${await hRest()}`);
    await setBodyClasses([], ["gutter-quiet", "gutter-rest-none"]);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    check("back to default: heading badge rests visible again", (await hRest()) > 0.5,
        `opacity=${await hRest()}`);

    // ── 4e. The code block's marker opens its menu (the one gutter that sits
    // nested inside a NodeView's contentDOM — posAtDOM must still resolve). ──
    const codeMarkerBox = await page.$eval(
        ":is(.ProseMirror > .code-block-wrapper, .ProseMirror > pre) .heading-fold-marker",
        (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        },
    );
    await page.mouse.click(codeMarkerBox.x, codeMarkerBox.y);
    await page.waitForTimeout(100);
    const codeActive = await page.$eval(
        ".block-menu .block-menu-item--active .block-menu-item-label",
        (el) => el.textContent,
    ).catch(() => null);
    check("code block marker opens its menu with Code Block active", codeActive === "Code Block",
        `active=${codeActive}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(50);

    // ── 5. Click opens the shared retype menu with P checked ──
    await page.mouse.click(markerBox.x, markerBox.y);
    await page.waitForTimeout(100);
    const menu = await page.$(".block-menu");
    check("clicking P opens the level menu", menu !== null);
    const activeLabel = await page.$eval(
        ".block-menu .block-menu-item--active .block-menu-item-label",
        (el) => el.textContent.trim(),
    );
    check("menu marks Paragraph as the current type", activeLabel === "Paragraph", `active=${activeLabel}`);

    // ── 6. Picking H2 promotes the paragraph ──
    const rows = await page.$$(".block-menu .block-menu-item");
    await rows[2].dispatchEvent("mousedown"); // Paragraph,Heading 1,Heading 2 → index 2
    await page.waitForTimeout(100);
    check("menu closed after pick", (await page.$(".block-menu")) === null);
    // Updates are debounced (300ms) — poll for the promoted line.
    let promoted = null;
    for (let i = 0; i < 30 && !promoted; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last?.includes("## First top-level paragraph here.")) promoted = last;
        else await page.waitForTimeout(100);
    }
    check("paragraph promoted to H2 in the serialized doc", promoted !== null);

    // The promoted block is now a heading — it gets the heading gutter, and
    // the P-marker count drops by one (the footnote-body paragraph keeps its).
    await page.waitForTimeout(150);
    const after = await page.$$eval(".heading-fold-marker--paragraph", (els) => els.length);
    check("promoted block no longer carries a P marker", after === 1, `count=${after}`);
}
