/**
 * Table-of-contents end-to-end checks against the real bundle. The behavior
 * under test — CSS transitions — is invisible to the jsdom unit suite, so it
 * can only be verified by driving dist/webview.js in a real browser.
 *
 * Contract:
 *   - The initial auto-open reveal on load is INSTANT (no slide/fade), so the
 *     switch into the rendered editor doesn't draw attention to itself.
 *   - A user-invoked show/hide STILL animates.
 *
 * The panel is first opened by toc.refresh() *after* the editor mounts (the
 * init rAF runs before getEditorView() exists), which is exactly why an earlier
 * fix that suppressed only the init rAF failed — this suite is the regression
 * guard for that.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".toc-panel", { timeout: 10000 });
    // Let the load-time auto-open settle (init rAF + refresh + any transitions).
    await page.waitForTimeout(500);

    const state = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel");
        return {
            open: !!panel?.classList.contains("toc-panel--open"),
            docked: document.body.classList.contains("toc-docked"),
            initialTransitions: window.__tocTransitions.slice(),
            // The suppression class must not be left stuck on the body.
            initialClassStuck: document.body.classList.contains("toc-initial"),
        };
    });

    // Guard the guard: if the panel never opened (e.g. overlay), a zero-transition
    // result would be a false pass. Assert we actually exercised the reveal.
    check("panel auto-opened docked on load", state.open && state.docked,
        `open=${state.open} docked=${state.docked}`);
    check("initial reveal is instant (no panel transitions on load)",
        state.initialTransitions.length === 0,
        JSON.stringify(state.initialTransitions));
    check("toc-initial suppression class is not left on <body>", !state.initialClassStuck);
    check("panel transitions are re-enabled after load (0.2s)",
        await page.locator(".toc-panel").evaluate((el) =>
            getComputedStyle(el).transitionDuration.split(",")[0].trim() === "0.2s"));

    // ── The drawer's card ─────────────────────────────────────────────
    // The card is the surface and the panel is its box, as the file
    // explorer's is: the card takes the ground, a radius, and a strip off
    // its own width for the sash, and the panel stands in from the window by
    // the shell's inset. Only a browser answers any of it.
    //
    // The GROUND is the page's own paper unless a host declares
    // --toc-panel-ground (the Mac app's Transparent table of contents
    // sidebar switch, turned off, is the one that does), and the tab strip
    // moves with the card, since a strip left on the paper over a shaded
    // card is the defect the alias exists to avoid. The flyout takes
    // neither the ground nor the geometry: it is a card of the shell's own.
    //
    // A sentinel colour rather than the palette's shade, because this page
    // is not the palette: what is under test is that one declaration reaches
    // the card and everything in it that paints the ground. Which colour the
    // Mac app puts there is its own to say, and its tests do.
    const GROUND = "rgb(1, 2, 3)";
    const ground = async () => page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.background = "var(--vscode-editor-background)";
        document.body.appendChild(probe);
        const paper = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const panel = document.querySelector(".toc-panel");
        const card = document.querySelector(".toc-card");
        const tabs = document.querySelector(".toc-tabs");
        const read = () => ({
            // The PANEL's own fill as well as the card's: the panel is the
            // box, and it has to stay the page's paper whatever the card is
            // given, or the strip it keeps for the sash is shaded too and
            // the sash line is back on the card's ground. Moving one
            // declaration from the card to the panel is the whole regression.
            panel: getComputedStyle(panel).backgroundColor,
            card: card ? getComputedStyle(card).backgroundColor : null,
            tabs: tabs ? getComputedStyle(tabs).backgroundColor : null,
            // The BOTTOM corner, because the top two are square: the drawer
            // is flush with the chrome above it and rounds only where it
            // stands in from the window (`toc.css`, `.files-card`).
            radius: card ? getComputedStyle(card).borderBottomLeftRadius : null,
            strip: card
                ? Math.round(panel.getBoundingClientRect().right - card.getBoundingClientRect().right)
                : null,
        });
        const docked = read();
        // BOTH modifier classes, which is what the shell writes for a real
        // flyout (`setPanelState`): a probe wearing one of them is a fixture
        // that could not express a defect the product can have.
        panel.classList.add("toc-panel--flyout", "side-panel--flyout");
        const flyout = read();
        panel.classList.remove("toc-panel--flyout", "side-panel--flyout");
        return { ...docked, flyout, paper };
    });
    const bare = await ground();
    // The floor first: every comparison below is against `paper`, and an
    // undeclared variable paints nothing, so a harness page that lost its
    // one colour would make all of them agree on transparent and pass.
    check("the page's paper is a real colour, so the comparisons below measure something",
        bare.paper !== "rgba(0, 0, 0, 0)" && bare.paper !== GROUND, JSON.stringify(bare));
    check("the card, its tab strip and the panel around it are the page's own paper with nothing declared",
        bare.card === bare.paper && bare.tabs === bare.paper && bare.panel === bare.paper,
        JSON.stringify(bare));
    // The geometry is the card's whatever the ground is, which is what makes
    // this drawer read as the file list's sibling rather than only when a
    // host has shaded it.
    check("the card is rounded below and gives a strip of its width back for the sash",
        bare.radius !== "0px" && bare.strip > 0, JSON.stringify(bare));
    // The flyout's ground and border are the SHELL's, painted on the panel,
    // so the drawer's card must add nothing there: no fill of its own (the
    // panel's shows through), no radius inside the shell's, and no strip
    // given up for a sash the flyout does not have. Its tab strip still
    // paints, because a stuck group header must not show through it.
    // The strip is 1 rather than 0 there, and that pixel is the flyout's own
    // border (sidePanel.css) counted into the panel's rect, not slack.
    check("the flyout is the shell's own card, so the drawer's card dresses nothing",
        bare.flyout.card === "rgba(0, 0, 0, 0)" && bare.flyout.radius === "0px"
            && bare.flyout.strip === 1 && bare.flyout.tabs === bare.paper
            // Its ground is the shell's, on the panel: that is the fill the
            // flyout actually shows, so it is the one to read.
            && bare.flyout.panel === bare.paper,
        JSON.stringify(bare.flyout));
    await page.evaluate((value) => {
        const style = document.createElement("style");
        style.id = "toc-ground-probe";
        style.textContent = `:root { --toc-panel-ground: ${value}; }`;
        document.head.appendChild(style);
    }, GROUND);
    await page.waitForTimeout(50);
    const declared = await ground();
    check("one declaration moves the card and its tab strip together",
        declared.card === GROUND && declared.tabs === GROUND, JSON.stringify(declared));
    // And stops at the card. The panel keeps the page's paper, which is what
    // makes the strip beside the sash read as page and the sash's line stand
    // off the card's rounded edge rather than lying along it.
    check("and the panel around the card keeps the page's paper, so the sash's strip is page",
        declared.panel === declared.paper && declared.panel !== declared.card, JSON.stringify(declared));
    // Including the flyout's own panel, which is where its ground is painted:
    // a `--toc-panel-ground` that reached `.toc-panel--flyout` would shade the
    // floating card silently, and every other clause here would still pass.
    check("and a declared ground reaches neither the flyout's card, its strip, nor its panel",
        declared.flyout.card === "rgba(0, 0, 0, 0)" && declared.flyout.tabs === declared.paper
            && declared.flyout.panel === declared.paper,
        JSON.stringify(declared.flyout));
    await page.evaluate(() => document.getElementById("toc-ground-probe")?.remove());
    await page.waitForTimeout(50);

    // ── Docked: the list clears the floating controls chip ──
    // The side-switch/hide buttons float over the list's top corner; the
    // first row must START below them (rows may still scroll beneath later).
    const clearance = await page.evaluate(() => ({
        controlsBottom: Math.round(
            document.querySelector(".toc-controls").getBoundingClientRect().bottom),
        firstTop: Math.round(
            document.querySelector(".toc-item").getBoundingClientRect().top),
    }));
    check("docked: the first TOC row starts below the floating controls (no overlap)",
        clearance.firstTop >= clearance.controlsBottom, JSON.stringify(clearance));

    // ── A user-invoked hide must still animate ──
    await page.evaluate(() => { window.__phase = "toggle"; });
    await page.evaluate(() => {
        document.querySelector(".toc-hide-btn")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await page.waitForTimeout(300);

    const toggleTransitions = await page.evaluate(() =>
        window.__tocTransitions.filter((t) => t.phase === "toggle"));
    check("user-invoked hide animates (panel transitions fire)",
        toggleTransitions.length > 0,
        JSON.stringify(toggleTransitions));
    check("panel is closed after the hide toggle",
        !(await page.locator(".toc-panel").evaluate((el) => el.classList.contains("toc-panel--open"))));

    // ── Flyout: hovering the collapsed reveal tab flies the panel out
    // transiently; leaving retracts it, and it never becomes a persistent open ──
    await page.waitForTimeout(300); // settle the collapse
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(350); // let the slide/fade-in (0.2s) settle
    const flyout = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel");
        const tab = document.querySelector(".toc-toggle-tab");
        const pr = panel.getBoundingClientRect();
        const tr = tab.getBoundingClientRect();
        return {
            flyout: panel.classList.contains("toc-panel--flyout"),
            bodyFlag: document.body.classList.contains("toc-flyout-open"),
            open: panel.classList.contains("toc-panel--open"),
            visible: getComputedStyle(panel).opacity === "1",
            belowTab: pr.top >= tr.bottom - 1, // panel starts at/under the tab's bottom
            sameSide: Math.abs(pr.left - tr.left) < 40, // roughly aligned to the tab
            tabMoved: Math.round(tr.left), // tab position captured for the "unmoved" check
            controlsHidden: getComputedStyle(panel.querySelector(".toc-controls")).display === "none",
            zIndex: parseInt(getComputedStyle(panel).zIndex, 10) || 0,
            capped: pr.height <= Math.min(0.7 * window.innerHeight, 620) + 1,
            gapTop: Math.round(tr.bottom), // for the hover-band probe below
            gapLeft: Math.round(pr.left + 40),
        };
    });
    check("hovering the tab flies the panel out", flyout.flyout && flyout.bodyFlag && flyout.visible,
        JSON.stringify(flyout));
    check("the flyout is transient, not a persistent open", !flyout.open);
    check("the flyout sits BELOW the tab, on its side (not the full-height drawer)",
        flyout.belowTab && flyout.sameSide, JSON.stringify(flyout));
    check("the flyout hides the docked drawer's controls", flyout.controlsHidden);
    // With the controls gone, the card keeps its own symmetric inset: the
    // first/last rows must not sit flush against the rounded border.
    const flyoutInset = await page.evaluate(() => {
        const panel = document.querySelector(".toc-panel").getBoundingClientRect();
        const items = document.querySelectorAll(".toc-item");
        return {
            top: Math.round(items[0].getBoundingClientRect().top - panel.top),
            bottom: Math.round(
                panel.bottom - items[items.length - 1].getBoundingClientRect().bottom),
        };
    });
    check("the flyout's first and last rows keep a breathing inset inside the card",
        flyoutInset.top >= 8 && flyoutInset.bottom >= 8, JSON.stringify(flyoutInset));
    check("the flyout is capped in height (the card scrolls, not the whole viewport)",
        flyout.capped, JSON.stringify(flyout));
    check("the flyout layers ABOVE the formatting/link palettes (z >= 9999)",
        flyout.zIndex >= 9999, `z=${flyout.zIndex}`);

    // Hover band: move into the gap between the tab and the flyout (below the
    // tab, above the panel, within the panel's width) — the flyout must stay.
    await page.mouse.move(flyout.gapLeft, flyout.gapTop + 3);
    await page.waitForTimeout(300); // longer than the grace period
    check("the hover band over the gap keeps the flyout open (no precision needed)",
        await page.evaluate(() =>
            document.querySelector(".toc-panel").classList.contains("toc-panel--flyout-in")));
    // ...but the band must NOT reach into the tab: the tab stays fully clickable
    // (its bottom edge hits the tab, not the panel's ::before band).
    check("the reveal tab stays fully clickable under the flyout (band doesn't steal it)",
        await page.evaluate(() => {
            const t = document.querySelector(".toc-toggle-tab").getBoundingClientRect();
            const el = document.elementFromPoint(t.left + t.width / 2, t.bottom - 2);
            return Boolean(el && el.closest(".toc-toggle-tab"));
        }));
    // The tab's own tooltip is suppressed while the flyout is out (it's redundant
    // and would overlap the panel) — no visible .custom-tooltip.
    const tipVisible = await page.evaluate(() => {
        const tip = document.querySelector(".custom-tooltip");
        return Boolean(tip && getComputedStyle(tip).display !== "none");
    });
    check("the tab tooltip is suppressed while the flyout is out", !tipVisible);

    // The reveal tab holds its hover look while the flyout is open (a non-
    // transparent background), even as the cursor roams the panel.
    check("the reveal tab shows its hover state while the flyout is open",
        await page.evaluate(() => {
            const bg = getComputedStyle(document.querySelector(".toc-toggle-tab")).backgroundColor;
            return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
        }));

    // The flyout uses a FIXED standard width, not the (possibly dragged) docked
    // --toc-width: widen the docked var and confirm the flyout stays put.
    await page.evaluate(() => document.documentElement.style.setProperty("--toc-width", "440px"));
    const flyoutW = await page.evaluate(() =>
        Math.round(document.querySelector(".toc-panel").getBoundingClientRect().width));
    check("the flyout uses a fixed standard width, not the dragged sidebar width",
        flyoutW === 260, `${flyoutW}px`);

    // The tall invisible band (up to the toolbar) keeps the flyout open when the
    // pointer is high in the column, not just in the 6px gap.
    const highPoint = await page.evaluate(() => {
        const p = document.querySelector(".toc-panel").getBoundingClientRect();
        return { x: Math.round(p.left + 60), y: Math.round(p.top - 18) };
    });
    await page.mouse.move(highPoint.x, highPoint.y);
    await page.waitForTimeout(300);
    check("hovering high in the band (toward the toolbar) keeps the flyout open",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--flyout-in")),
        JSON.stringify(highPoint));

    // Move the pointer away → the flyout retracts after its grace period.
    await page.mouse.move(760, 420);
    await page.waitForTimeout(400);
    const retracted = await page.evaluate(() => ({
        flyout: document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"),
        bodyFlag: document.body.classList.contains("toc-flyout-open"),
    }));
    check("leaving the tab/panel retracts the flyout",
        !retracted.flyout && !retracted.bodyFlag, JSON.stringify(retracted));

    // A drag holds the flyout open (block-dragging guard); when it ends with the
    // pointer OFF the panel, the flyout must not get stuck open (mouseup re-check).
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(350);
    await page.mouse.move(800, 520); // pointer well off the tab/panel/band
    const stuck = await page.evaluate(async () => {
        document.body.classList.add("block-dragging");
        document.querySelector(".toc-panel").dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 250));
        const during = document.body.classList.contains("toc-flyout-open");
        document.body.classList.remove("block-dragging");
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); // drag ends off-panel
        await new Promise((r) => setTimeout(r, 500));
        return { during, after: document.body.classList.contains("toc-flyout-open") };
    });
    check("a drag holds the flyout open, then it retracts when the drag ends off-panel",
        stuck.during && !stuck.after, JSON.stringify(stuck));

    // ── Keyboard: the tab is focusable (Tab order); focus flies it out, and
    // Enter docks it open persistently (a11y — not pointer-only) ──
    await page.evaluate(() => document.querySelector(".toc-toggle-tab").focus());
    await page.waitForTimeout(350);
    check("focusing the tab flies the panel out",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--flyout")));
    check("the reveal tab is in the tab order (tabIndex 0)",
        await page.evaluate(() => document.querySelector(".toc-toggle-tab").tabIndex === 0));
    await page.evaluate(() => document.querySelector(".toc-toggle-tab")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await page.waitForTimeout(300);
    check("Enter on the focused tab docks the panel open",
        await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--open")));

    // ── Typing above a heading re-anchors the rows IN PLACE (never rebuilds) ──
    // Every heading's document position shifts when you type above it, but the
    // outline still LOOKS identical, so the rows must survive and simply take
    // new anchors. Rebuilding them instead is invisible in a screenshot and
    // ruinous in a big document (it was every row, every keystroke), so the
    // only way to pin it is element IDENTITY: stamp each row with an expando,
    // which no attribute copy would carry, and require it to survive the edit.
    // The dataset must nonetheless move, or the rows still point at stale
    // positions — the two halves together are the whole contract.
    await page.evaluate(() => {
        document.querySelectorAll(".toc-item").forEach((el, i) => { el.__probeId = i; });
    });
    const before = await page.$$eval(".toc-item", (els) =>
        els.map((e) => e.dataset.headingPos));
    // Caret into the FIRST body paragraph — above every heading but the first,
    // so their positions all shift while no heading's text changes.
    await page.evaluate(() => {
        const p = document.querySelector(".ProseMirror > p");
        const r = document.createRange();
        r.selectNodeContents(p);
        r.collapse(false);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
    });
    await page.keyboard.type("zz");
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
        ids: [...document.querySelectorAll(".toc-item")].map((e) => e.__probeId),
        pos: [...document.querySelectorAll(".toc-item")].map((e) => e.dataset.headingPos),
        labels: [...document.querySelectorAll(".toc-item")].map((e) => e.textContent),
    }));
    check("typing above a heading does NOT rebuild the outline rows (identity survives)",
        JSON.stringify(after.ids) === JSON.stringify([0, 1, 2, 3, 4]), JSON.stringify(after.ids));
    check("...and every shifted row is re-anchored to its new document position",
        after.pos.length === before.length &&
        after.pos.every((p, i) => i === 0 ? p === before[i] : Number(p) === Number(before[i]) + 2),
        JSON.stringify({ before, after: after.pos }));
    check("...and the outline still reads the same",
        JSON.stringify(after.labels) === JSON.stringify(["One", "Two", "Three", "Four", "Five"]),
        JSON.stringify(after.labels));

    // ── The flyout opens at the reader's place, not at the top ──
    // The list renders before the card's capped geometry exists, so without a
    // post-layout correction the active row (the section you're reading) can
    // sit below the fold. Shrink the viewport so the 5-row list genuinely
    // overflows the 70vh card cap, scroll the DOCUMENT to the bottom (active
    // heading = a late section), then fly out and require the active row to be
    // visible inside the list's viewport.
    await page.setViewportSize({ width: 1000, height: 220 });
    await page.evaluate(() => {
        document.querySelector(".toc-hide-btn")
            ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await page.waitForTimeout(300); // settle the collapse
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(250); // let the scroll-driven active update run
    await page.locator(".toc-toggle-tab").hover();
    await page.waitForTimeout(350);
    const opensAtPlace = await page.evaluate(() => {
        const listEl = document.querySelector(".toc-list");
        const activeEl = document.querySelector(".toc-item--active");
        if (!activeEl) {
            return { active: null };
        }
        const l = listEl.getBoundingClientRect();
        const a = activeEl.getBoundingClientRect();
        return {
            active: activeEl.textContent,
            scrollable: listEl.scrollHeight > listEl.clientHeight,
            scrollTop: Math.round(listEl.scrollTop),
            visible: a.top >= l.top - 1 && a.bottom <= l.bottom + 1,
        };
    });
    check("shrunk viewport: the flyout list actually overflows (guard the guard)",
        opensAtPlace.active !== null && opensAtPlace.scrollable, JSON.stringify(opensAtPlace));
    check("the flyout opens scrolled to the active heading (not the top)",
        opensAtPlace.visible && opensAtPlace.scrollTop > 0, JSON.stringify(opensAtPlace));
    await page.mouse.move(800, 100); // retract the flyout
    await page.setViewportSize({ width: 1000, height: 720 });
}
