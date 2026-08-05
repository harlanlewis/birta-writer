/**
 * Per-block width (blockWidth.ts) end-to-end checks against the real bundle,
 * in FIXED page-width mode (the harness injects the provider's fixed-mode
 * shape): embed cards center in the column and their control column carries
 * [open, width, gap, edit, as-link]; the width toggles break embed / image /
 * code blocks out of the column without ever creating horizontal overflow or
 * touching the document; images cycle natural → column → full; preferences
 * land in the webview state bag.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // The embed decoration pass and the img-block pass arm on idle (≤1s).
    await page.waitForSelector(".embed-card--player", { timeout: 10000 });
    await page.waitForSelector(".ProseMirror p.img-block", { timeout: 10000 });

    const geometry = () =>
        page.evaluate(() => {
            const editor = document.querySelector("#editor");
            const cs = getComputedStyle(editor);
            const rect = editor.getBoundingClientRect();
            return {
                contentLeft: rect.left + parseFloat(cs.paddingLeft),
                contentRight: rect.right - parseFloat(cs.paddingRight),
                pane: document.documentElement.clientWidth,
            };
        });

    check(
        "--bw-pane publishes the pane's client width",
        await page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--bw-pane").trim()
            === `${document.documentElement.clientWidth}px`),
    );

    check(
        "fixed page mode is actually active in the harness (no vacuous pass)",
        await page.evaluate(() => !document.body.classList.contains("editor-width-auto")),
    );

    // ── Embed card: centered, and the control column order ──
    const embed = await page.evaluate(() => {
        const host = document.querySelector(".embed-card-host");
        const card = host.querySelector(".embed-card");
        const controls = [...host.querySelectorAll(".embed-card__controls > *")]
            .map((el) => el.className);
        const stop = host.querySelector(".embed-card__stop");
        const h = host.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return {
            controls,
            stopHidden: stop.hidden,
            centerDelta: Math.abs((h.left + h.right) / 2 - (c.left + c.right) / 2),
        };
    });
    check(
        "the embed card centers in the column",
        embed.centerDelta <= 1.5,
        `delta=${embed.centerDelta.toFixed(1)}`,
    );
    check(
        "control column order is [stop, open, width, fullscreen, gap, edit, as-link]",
        JSON.stringify(embed.controls) === JSON.stringify([
            "bc-btn embed-card__stop",
            "bc-btn embed-card__external",
            "bc-btn embed-card__width",
            "bc-btn embed-card__fullscreen",
            "bc-gap",
            "bc-btn embed-card__edit",
            "bc-btn embed-card__aslink",
        ]),
        JSON.stringify(embed.controls),
    );
    check("the stop button stays hidden until playing", embed.stopHidden === true);

    // ── Visibility: hidden at rest, revealed by hover, selection, or caret ──
    const colOpacity = (sel) =>
        page.evaluate((s) => getComputedStyle(document.querySelector(s)).opacity, sel);
    check(
        "control columns are hidden at rest",
        (await colOpacity(".embed-card__controls")) === "0" &&
            (await colOpacity(".code-block-wrapper .bc-col")) === "0",
        `embed=${await colOpacity(".embed-card__controls")} code=${await colOpacity(".code-block-wrapper .bc-col")}`,
    );
    check(
        "the code column's hit strip spans the block's full height (no precision mousing)",
        await page.evaluate(() => {
            const wrap = document.querySelector(".code-block-wrapper");
            const col = wrap.querySelector(".bc-col");
            const w = wrap.getBoundingClientRect();
            const c = col.getBoundingClientRect();
            return Math.abs(c.height - w.height) <= 2 && c.left >= w.right - 1 && c.width >= 40;
        }),
    );
    // The code column mounts EMPTY and attaches its buttons on first reveal
    // (webview/ui/blockControls.ts, MAR-251), so every check below that reads
    // a button needs the hover that a user would make anyway. This is also
    // the check that the hover path populates at all — an unrevealed column
    // has no `.bc-btn` and the height assertion would find nothing.
    check(
        "the code column has no buttons before it is ever revealed",
        (await page.locator(".code-block-wrapper .bc-col .bc-btn").count()) === 0,
        `count=${await page.locator(".code-block-wrapper .bc-col .bc-btn").count()}`,
    );
    await page.locator(".code-block-wrapper pre").hover();
    await page.waitForTimeout(50);
    check(
        "hovering the code block populates its column",
        (await page.locator(".code-block-wrapper .bc-col .bc-btn").count()) === 5,
        `count=${await page.locator(".code-block-wrapper .bc-col .bc-btn").count()}`,
    );
    check(
        "a SHORT block never squashes its buttons — they overflow at full size",
        await page.evaluate(() => {
            const heights = [...document.querySelectorAll(".code-block-wrapper .bc-btn")]
                .filter((b) => getComputedStyle(b).display !== "none")
                .map((b) => Math.round(b.getBoundingClientRect().height));
            return heights.length >= 3 && heights.every((h) => h === 28);
        }),
    );
    // Selecting the embed card (click) reveals its controls without hover.
    await page.locator(".embed-card__meta-url").click();
    await page.waitForTimeout(150);
    await page.mouse.move(5, 5); // pointer away — selection alone must hold it open
    await page.waitForTimeout(200);
    check(
        "a SELECTED embed keeps its controls visible without hover",
        (await colOpacity(".embed-card__controls")) === "1",
        `opacity=${await colOpacity(".embed-card__controls")}`,
    );
    await page.keyboard.press("Escape");
    // A caret inside a table cell keeps the table's column visible — reached
    // from the paragraph BELOW by keyboard, with the pointer parked far away,
    // so no pointer event over the table can carry the reveal. Clicking a cell
    // (the obvious gesture) would hover the table on the way in and make both
    // of the checks below pass for the wrong reason.
    await page.getByText("tail text").click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(50);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(250);
    const tableActive = await page.evaluate(() => ({
        active: document.querySelector(".mw-table").classList.contains("bc-active"),
        opacity: getComputedStyle(document.querySelector(".mw-table .bc-col")).opacity,
        buttons: document.querySelectorAll(".mw-table .bc-col .bc-btn").length,
    }));
    check(
        "a caret inside a table cell keeps the table's controls visible",
        tableActive.active && tableActive.opacity === "1",
        JSON.stringify(tableActive),
    );
    // The `bc-active` reveal has no pointer event to hang population on; the
    // strip's own opacity transition is what carries it (MAR-251). A revealed
    // but EMPTY column is the failure this pins.
    check(
        "the caret reveal populates the column, not just fades an empty strip",
        tableActive.buttons === 1,
        JSON.stringify(tableActive),
    );
    await page.keyboard.press("Escape");

    // ── Embed width toggle: breakout, no overflow, persisted, reversible ──
    await page.locator(".embed-card__width").dispatchEvent("click");
    await page.waitForTimeout(50);
    let geo = await geometry();
    const fullEmbed = await page.evaluate(() => {
        const host = document.querySelector(".embed-card-host");
        const r = host.getBoundingClientRect();
        return {
            hasClass: host.classList.contains("bw-full"),
            left: r.left,
            right: r.right,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            stored: window.__state?.blockWidths,
        };
    });
    check("the width toggle marks the host bw-full", fullEmbed.hasClass);
    check(
        "a full-width embed breaks out LEFT of the fixed column",
        fullEmbed.left < geo.contentLeft - 8,
        `host.left=${fullEmbed.left.toFixed(0)} column.left=${geo.contentLeft.toFixed(0)}`,
    );
    check(
        "a full-width embed breaks out RIGHT of the fixed column",
        fullEmbed.right > geo.contentRight + 8,
        `host.right=${fullEmbed.right.toFixed(0)} column.right=${geo.contentRight.toFixed(0)}`,
    );
    check("the breakout never creates horizontal overflow", fullEmbed.overflow === false);
    check(
        "the embed width preference persists to the state bag",
        fullEmbed.stored?.["embed:https://www.youtube.com/watch?v=dQw4w9WgXcQ"] === "full",
        JSON.stringify(fullEmbed.stored),
    );

    await page.locator(".embed-card__width").dispatchEvent("click");
    await page.waitForTimeout(50);
    const revertedEmbed = await page.evaluate(() => {
        const host = document.querySelector(".embed-card-host");
        return {
            hasClass: host.classList.contains("bw-full"),
            stored: window.__state?.blockWidths ?? {},
        };
    });
    check(
        "a second click reverts the embed to fixed width and clears the store",
        !revertedEmbed.hasClass && Object.keys(revertedEmbed.stored).length === 0,
        JSON.stringify(revertedEmbed.stored),
    );

    // ── Standalone image: centered at natural size, 3-step width cycle ──
    const naturalImage = await page.evaluate(() => {
        const p = document.querySelector(".ProseMirror p.img-block");
        const wrapper = p.querySelector(".image-wrapper");
        const img = p.querySelector("img.image-node");
        const pr = p.getBoundingClientRect();
        const wr = wrapper.getBoundingClientRect();
        return {
            centerDelta: Math.abs((pr.left + pr.right) / 2 - (wr.left + wr.right) / 2),
            // The IMG, not the wrapper — the wrapper also holds the caption
            // input, which is wider than this 48px fixture.
            imgWidth: img.getBoundingClientRect().width,
        };
    });
    check(
        "a standalone image centers in the column at natural size",
        naturalImage.centerDelta <= 1.5 && naturalImage.imgWidth <= 50,
        `delta=${naturalImage.centerDelta.toFixed(1)} imgWidth=${naturalImage.imgWidth.toFixed(0)}`,
    );

    // Select the image so its toolbar (and the width button) shows.
    await page.locator("img.image-node").click();
    await page.waitForSelector(".img-tb-width", { state: "visible", timeout: 5000 });

    await page.locator(".img-tb-width").dispatchEvent("click");
    await page.waitForTimeout(50);
    const fixedImage = await page.evaluate(() => {
        const p = document.querySelector(".ProseMirror p.img-block");
        const wrapper = p.querySelector(".image-wrapper");
        return {
            cls: wrapper.className,
            pWidth: p.getBoundingClientRect().width,
            wWidth: wrapper.getBoundingClientRect().width,
        };
    });
    check(
        "first cycle: the image fills the column (bw-fixed)",
        fixedImage.cls.includes("bw-fixed") && Math.abs(fixedImage.pWidth - fixedImage.wWidth) <= 2,
        `p=${fixedImage.pWidth.toFixed(0)} wrapper=${fixedImage.wWidth.toFixed(0)} cls=${fixedImage.cls}`,
    );

    await page.locator(".img-tb-width").dispatchEvent("click");
    await page.waitForTimeout(50);
    geo = await geometry();
    const fullImage = await page.evaluate(() => {
        const wrapper = document.querySelector(".ProseMirror p.img-block .image-wrapper");
        const r = wrapper.getBoundingClientRect();
        return {
            cls: wrapper.className,
            left: r.left,
            right: r.right,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
    });
    check(
        "second cycle: the image breaks out of the column (bw-full), no overflow",
        fullImage.cls.includes("bw-full")
            && fullImage.left < geo.contentLeft - 8
            && fullImage.right > geo.contentRight + 8
            && !fullImage.overflow,
        `left=${fullImage.left.toFixed(0)} col=[${geo.contentLeft.toFixed(0)},${geo.contentRight.toFixed(0)}] cls=${fullImage.cls}`,
    );

    await page.locator(".img-tb-width").dispatchEvent("click");
    await page.waitForTimeout(50);
    const cycledImage = await page.evaluate(() => {
        const wrapper = document.querySelector(".ProseMirror p.img-block .image-wrapper");
        const img = wrapper.querySelector("img.image-node");
        return { cls: wrapper.className, imgWidth: img.getBoundingClientRect().width };
    });
    check(
        "third cycle: back to natural size",
        !cycledImage.cls.includes("bw-full") && !cycledImage.cls.includes("bw-fixed")
            && cycledImage.imgWidth <= 50,
        `imgWidth=${cycledImage.imgWidth.toFixed(0)} cls=${cycledImage.cls}`,
    );

    // ── Code block: header width toggle breaks out and reverts ──
    await page.locator(".code-block-wrapper pre").hover();
    await page.locator(".code-block-wrapper .code-width-toggle-btn").dispatchEvent("mousedown");
    await page.waitForTimeout(50);
    geo = await geometry();
    const fullCode = await page.evaluate(() => {
        const wrapper = document.querySelector(".code-block-wrapper");
        const r = wrapper.getBoundingClientRect();
        return {
            hasClass: wrapper.classList.contains("bw-full"),
            left: r.left,
            right: r.right,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            stored: window.__state?.blockWidths,
        };
    });
    check(
        "a full-width code block breaks out of the fixed column, no overflow",
        fullCode.hasClass
            && fullCode.left < geo.contentLeft - 8
            && fullCode.right > geo.contentRight + 8
            && !fullCode.overflow,
        `left=${fullCode.left.toFixed(0)} col=[${geo.contentLeft.toFixed(0)},${geo.contentRight.toFixed(0)}]`,
    );
    check(
        "the code width preference persists, anchored on the first line",
        fullCode.stored?.["code:const answer = 42;"] === "full",
        JSON.stringify(fullCode.stored),
    );

    await page.locator(".code-block-wrapper .code-width-toggle-btn").dispatchEvent("mousedown");
    await page.waitForTimeout(50);
    check(
        "the code block reverts to column width",
        await page.evaluate(() => !document.querySelector(".code-block-wrapper").classList.contains("bw-full")),
    );

    // ── Fixed page + docked-open TOC: a full-width block spans the LEFTOVER
    //    space beside the drawer (the exact span page-full-width content
    //    would get: drawer + gap on the left, right padding on the right). ──
    await page.evaluate(() => {
        document.querySelector(".toc-toggle-tab")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        document.documentElement.style.setProperty("--toc-width", "300px");
    });
    await page.waitForTimeout(300);
    check(
        "the TOC is docked open for the breakout check (no vacuous pass)",
        await page.evaluate(() =>
            document.body.classList.contains("toc-open") && !document.body.classList.contains("toc-right")),
    );
    await page.locator(".embed-card__width").dispatchEvent("click");
    await page.waitForTimeout(50);
    const tocFull = await page.evaluate(() => {
        const host = document.querySelector(".embed-card-host");
        const r = host.getBoundingClientRect();
        const de = document.documentElement;
        return {
            left: r.left,
            right: r.right,
            pane: de.clientWidth,
            overflow: de.scrollWidth > de.clientWidth,
        };
    });
    check(
        "beside a docked TOC, a full-width block starts past the drawer reserve (300px drawer + 100px gap)",
        Math.abs(tocFull.left - 400) <= 2,
        `left=${tocFull.left.toFixed(0)}`,
    );
    check(
        "…ends at the pane's right padding, without horizontal overflow",
        Math.abs(tocFull.pane - 48 - tocFull.right) <= 2 && !tocFull.overflow,
        `right=${tocFull.right.toFixed(0)} pane=${tocFull.pane}`,
    );
    await page.locator(".embed-card__width").dispatchEvent("click");
    await page.evaluate(() => {
        document.documentElement.style.removeProperty("--toc-width");
        document.querySelector(".toc-toggle-tab")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await page.waitForTimeout(200);

    // ── Scroll anchoring with an EMBED as the top visible block: the card's
    //    hidden link defeats coordsAtPos (flat rect), so the anchor must fall
    //    back to the block's real DOM box. The intro paragraph above the card
    //    rewraps on the flip, so without a working anchor the card drifts. ──
    await page.setViewportSize({ width: 1000, height: 420 });
    await page.waitForTimeout(150);
    const cardTop = () =>
        page.evaluate(() => document.querySelector(".embed-card-host").getBoundingClientRect().top);
    await page.evaluate(() => {
        const host = document.querySelector(".embed-card-host");
        const topbar = document.querySelector(".editor-topbar").getBoundingClientRect().height;
        window.scrollTo({ top: host.getBoundingClientRect().top + window.scrollY - topbar - 4 });
    });
    await page.waitForTimeout(100);
    const anchorBefore = await cardTop();
    // Flip fixed → full via the real toolbar control (the harness boots fixed).
    const fontWrap = page.locator('[data-item-id="fontPreset"]');
    await fontWrap.dispatchEvent("mouseenter");
    await page.waitForTimeout(150);
    await page.locator(".tb-font-menu .tb-seg-btn").nth(0).dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    const anchorAfter = await cardTop();
    check(
        "a width flip with an embed at the top keeps the card anchored",
        Math.abs(anchorAfter - anchorBefore) <= 6,
        `before=${anchorBefore.toFixed(0)} after=${anchorAfter.toFixed(0)}`,
    );
    // Flip back (fixed) so the state matches the harness's boot mode.
    await fontWrap.dispatchEvent("mouseenter");
    await page.waitForTimeout(150);
    await page.locator(".tb-font-menu .tb-seg-btn").nth(1).dispatchEvent("mousedown");
    await page.waitForTimeout(200);

    // ── Fidelity: width toggles are presentation-only — the document never
    //    changed, so nothing was serialized webview→extension. ──
    const updates = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "update" || m.type === "flushResult").length);
    check("no width action ever serialized the document", updates === 0, `updates=${updates}`);
}
