/**
 * The host profile end-to-end (MAR-373): the same bundle mounted with the mac
 * profile has none of the toolbar items, gear rows or slash rows that name
 * something its shell does not provide, keeps a chord bound to such a command
 * inert, and still edits. What the shell DOES provide (`imageUpload`, `toc`)
 * keeps its item and its row, which is the arm that stops a build gating
 * everything from passing.
 *
 * The two ARRANGEMENTS the profile also declares are checked here rather than
 * in jsdom, because both are claims about layout: `formattingInSecondRow`
 * moves every document-editing control into a strip at the bottom leading
 * corner that scrolls when it does not fit, and `fixedToolbarLayout` takes
 * away the customize mode and the hide row that would otherwise rearrange it.
 * jsdom has no layout engine, so it can see the DOM move and not the scroll,
 * the clipping, or the dropdown that has to escape it.
 *
 * control.html is the same page with the field ABSENT, which must read as the
 * VS Code host, so a build that lost the TOC for everyone fails here rather
 * than passing.
 */
export async function run({ page, check, baseUrl }) {
    // The Mac app declares `imageUpload`, so the Image item is NOT gated here: it is
    // in the list below, as one of the editor's own items that must survive.
    const GATED_ITEMS = ["viewSource", "readOnly"];
    const OPEN_WAIT = 220;

    async function mount(file) {
        await page.goto(`${baseUrl}/${file}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForFunction(
            () => /Some text/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
            { timeout: 10000 },
        );
        await page.waitForTimeout(400);
    }
    const itemIds = () => page.$$eval(".tb-item", (els) => els.map((el) => el.dataset.itemId));

    // ── The control: absent means all ──────────────────────────────────
    await mount("control.html");
    const ctl = await page.evaluate(() => ({
        toc: !!document.querySelector(".toc-panel"),
        items: [...document.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId),
        dock: !!document.querySelector(".tb-dock"),
        leftZone: [...document.querySelectorAll(".tb-zone--left .tb-item")].map((el) => el.dataset.itemId),
        // The three controls the mac profile withdraws from the sidebar. Read
        // here so the absence checks further down are a DIFFERENCE rather than
        // three selectors that might match nothing in any build.
        flip: !!document.querySelector(".toc-flip-btn"),
        hide: !!document.querySelector(".toc-hide-btn"),
        revealTab: !!document.querySelector(".toc-toggle-tab"),
    }));
    check("control: the TOC panel exists when hostCapabilities is absent", ctl.toc);
    check("control: and it keeps its own flip, hide and reveal-tab controls",
        ctl.flip && ctl.hide && ctl.revealTab, JSON.stringify(ctl));
    check("control: no formatting dock, because the arrangement is not declared", !ctl.dock);
    check("control: the editing controls are in the top bar's left zone",
        ctl.leftZone.includes("bold") && ctl.leftZone.includes("format"),
        JSON.stringify(ctl.leftZone));
    check("control: viewSource, styleCheck and image are on the bar when hostCapabilities is absent",
        ["viewSource", "styleCheck", "image"].every((id) => ctl.items.includes(id)),
        JSON.stringify(ctl.items));

    // ── The mac profile ────────────────────────────────────────────────
    await mount("index.html");
    const mac = await page.evaluate(() => ({
        toc: !!document.querySelector(".toc-panel"),
        tocOpen: document.body.classList.contains("toc-open")
            || document.body.classList.contains("toc-overlay-open"),
        items: [...document.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId),
        dock: [...document.querySelectorAll(".tb-dock-row .tb-item")].map((el) => el.dataset.itemId),
        leftZone: [...document.querySelectorAll(".tb-zone--left .tb-item")].map((el) => el.dataset.itemId),
        // Placeable items only: the two status badges and the dev-only debug
        // dropdown are PINNED into the right zone by the layout controller and
        // belong to neither surface of the partition.
        rightZone: [...document.querySelectorAll(".tb-zone--right .tb-item")]
            .map((el) => el.dataset.itemId)
            .filter((id) => !["syncConflict", "logseq", "debug"].includes(id)),
        showTab: !!document.querySelector(".toolbar-toggle-tab"),
    }));
    check("mac: the sidebar exists, because the shell declares it", mac.toc);
    check("mac: and it starts put away, as the shell's boot config asks",
        !mac.tocOpen, JSON.stringify({ open: mac.tocOpen }));
    check("mac: no host-bound .tb-item in any zone",
        GATED_ITEMS.every((id) => !mac.items.includes(id)), JSON.stringify(mac.items));
    check("mac: the editor's own items are all still built",
        ["format", "bold", "link", "table", "find", "settings"].every((id) => mac.items.includes(id)),
        JSON.stringify(mac.items));

    // ── The style check actually DRAWS here ────────────────────────────
    //
    // The half every check over the Checks menu stops short of. The menu can
    // offer Check style, and every row can be present and checkmarked, while
    // the master gate the SHELL sends in its boot config holds the whole pass
    // off and not one underline is drawn. That is a state the menu looks
    // correct in, which is why this asks the document rather than the chrome.
    const styleHits = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror .pf-style-hit").length);
    check("mac: the style check the page computes for itself draws its underlines",
        styleHits > 0, JSON.stringify({ hits: styleHits }));

    // ── The Checks menu, which mixes gated and unconditional rows ──────
    //
    // The item is NOT gated (MAR-414's neighbour): the style check is computed
    // in the page, so a host without a lint engine keeps it and loses only the
    // two rows that post out. Gating the whole item took the menu away from a
    // surface that could run half of it. This shell answers lints now, so all
    // four rows are here, and what the check still discriminates is that they
    // are built from the capability rather than hardcoded. Driven by opening
    // the menu rather than read off the registry, because the filtering happens
    // where the rows are built and a unit test of the table cannot see it.
    const checksTrigger = await page.$('.tb-item[data-item-id="styleCheck"] .tb-fmt-trigger, .tb-checks-wrap .ui-btn');
    check("mac: the Checks item is on the bar", !!checksTrigger);
    if (checksTrigger) {
        await checksTrigger.hover();
        await page.waitForTimeout(OPEN_WAIT);
        const rows = await page.$$eval(".tb-checks-menu .tb-fmt-item, .tb-checks-menu .ui-menu-row",
            (els) => els.map((el) => el.textContent.trim()).filter(Boolean));
        check("mac: the Checks menu offers the style check the page computes itself",
            rows.some((r) => /Check style/i.test(r)), JSON.stringify(rows));
        check("mac: and the note-marker highlight beside it",
            rows.some((r) => /note markers/i.test(r)), JSON.stringify(rows));
        check("mac: and both lint rows, because this shell answers lints now",
            rows.some((r) => /Check spelling/i.test(r)) && rows.some((r) => /Check grammar/i.test(r)),
            JSON.stringify(rows));
        await page.mouse.move(5, 400);
        await page.waitForTimeout(OPEN_WAIT);
    }

    // ── The sidebar's toolbar button ───────────────────────────────────
    //
    // The panel is put away on this surface, so the bar's own button is how it
    // is reached. Two things only a real page answers: whether pressing it
    // actually brings the panel out, and whether the button then LOOKS pressed.
    // The second is not decoration: it holds no state of its own and takes its
    // lit look from the classes the panel sets to position itself, so this is
    // what fails if those two ever stop being the same fact.
    const tocButton = await page.$('.tb-item[data-item-id="toc"] .tb-toc-btn');
    check("mac: the sidebar's toggle is on the bar", !!tocButton);
    if (tocButton) {
        const tocState = () => page.evaluate(() => ({
            open: document.body.classList.contains("toc-open")
                || document.body.classList.contains("toc-overlay-open"),
            // The panel's own box and its own visibility, not the body class:
            // a class that moved nothing is the failure a class check cannot
            // see. Visibility is in it because that is what the panel uses to
            // take its focus stops out of reach, and it is the half that
            // settles rather than animating.
            panelOnScreen: (() => {
                const el = document.querySelector(".toc-panel");
                if (!el || getComputedStyle(el).visibility === "hidden") { return false; }
                const box = el.getBoundingClientRect();
                return box.width > 0 && box.right > 0 && box.left < window.innerWidth;
            })(),
            // The panel anchors itself to the bar's bottom edge, and on this
            // surface that bar is TWO rows rather than the one every other host
            // gives it. A panel that measured the single-row height would open
            // with its first heading under the formatting controls, which is
            // the arrangement-specific way this lands wrong.
            clearsBar: (() => {
                const panel = document.querySelector(".toc-panel");
                const bar = document.querySelector(".editor-topbar");
                if (!panel || !bar) { return false; }
                return panel.getBoundingClientRect().top
                    >= bar.getBoundingClientRect().bottom - 0.5;
            })(),
            lit: getComputedStyle(document.querySelector(".tb-toc-btn")).backgroundColor,
            // The numbers behind `clearsBar`, in the payload rather than left
            // to be re-derived: a bare false there says the panel is under the
            // bar and not whether it is six pixels short (still sliding) or
            // three hundred (measuring the wrong bar).
            panelTop: Math.round(document.querySelector(".toc-panel")?.getBoundingClientRect().top ?? -1),
            barBottom: Math.round(document.querySelector(".editor-topbar")?.getBoundingClientRect().bottom ?? -1),
        }));
        // The panel slides, so every reading below waits for it to come to rest
        // rather than for a number: a fixed pause sized to the transition is a
        // check that goes red on a busy machine and says nothing about the
        // code. It polls the SAME predicate the checks read, so it cannot
        // settle on a half-open panel, and a timeout is swallowed because the
        // check that reads the state next is what should report it.
        const settled = async (wanted) => {
            try {
                await page.waitForFunction((shown) => {
                    const el = document.querySelector(".toc-panel");
                    const bar = document.querySelector(".editor-topbar");
                    if (!el || !bar) { return false; }
                    const box = el.getBoundingClientRect();
                    const out = getComputedStyle(el).visibility !== "hidden"
                        && box.width > 0 && box.right > 0 && box.left < window.innerWidth;
                    if (out !== shown) { return false; }
                    // On screen is not AT REST. The panel slides, and every
                    // measurement above is already true a few frames in, so a
                    // reading taken here was of a panel still moving: it sat
                    // six pixels above the bar's bottom edge and its button was
                    // mid-transition, both of which read as product faults. So
                    // the shown case waits for the geometry the checks below
                    // actually assert, which is what this poll claimed to do
                    // and did not.
                    return !shown
                        || box.top >= bar.getBoundingClientRect().bottom - 0.5;
                }, wanted, { timeout: 4000 });
            } catch { /* reported by the check that reads the state next */ }
            return tocState();
        };

        const shut = await tocState();
        await tocButton.click();
        const open = await settled(true);
        check("mac: pressing it brings the sidebar onto the screen",
            open.open && open.panelOnScreen, JSON.stringify({ shut, open }));
        check("mac: and it starts below the whole bar, both rows of it",
            open.clearsBar, JSON.stringify(open));
        check("mac: and the button says so, from the panel's own classes",
            open.lit !== shut.lit, JSON.stringify({ shut: shut.lit, open: open.lit }));

        // A tab the strip has HIDDEN must take no width, or the row it is
        // measured in has more items in it than the measurement is told about.
        // This fixture is the case: one heading list and one style finding, so
        // Links and Notes carry nothing and the strip hides both. They went on
        // drawing anyway, because `.toc-tab` composes `.ui-btn`, whose `display`
        // beat the UA's `[hidden] { display: none }`. Four tabs then wrapped to
        // two rows and the strip's own overflow logic collapsed them all to a
        // select button, on a panel with two tabs and room for four.
        //
        // `hiddenCount` is the arm: with nothing hidden every claim below is
        // true of a strip this could never have been asked of.
        const strip = await page.evaluate(() => {
            const tabs = [...document.querySelectorAll(".toc-tab")];
            const drawn = (el) => el.getClientRects().length > 0;
            return {
                hidden: tabs.filter((t) => t.hidden).map((t) => t.textContent),
                drawnHidden: tabs.filter((t) => t.hidden && drawn(t)).map((t) => t.textContent),
                rows: new Set(tabs.filter(drawn).map((t) => t.offsetTop)).size,
                selectMode: document.querySelector(".toc-tabs").classList.contains("toc-tabs--select"),
            };
        });
        check("mac: the fixture really does hide some of the review tabs",
            strip.hidden.length > 0, JSON.stringify(strip));
        check("mac: a hidden review tab is not drawn",
            strip.drawnHidden.length === 0, JSON.stringify(strip));
        check("mac: so the tab strip stays one row and keeps its tabs",
            strip.rows === 1 && !strip.selectMode, JSON.stringify(strip));

        // ── fixedTocSide ──────────────────────────────────────────────
        // The side is the app's, and it is the trailing edge. Asserted as the
        // panel's own box against the viewport, not as the body class that is
        // supposed to place it: the class is what this page was handed, and a
        // panel that ignored it would leave the class reading correctly on a
        // sidebar sitting on the wrong edge.
        const side = await page.evaluate(() => {
            const box = document.querySelector(".toc-panel").getBoundingClientRect();
            return {
                declared: document.body.classList.contains("toc-right"),
                gapRight: Math.round(window.innerWidth - box.right),
                gapLeft: Math.round(box.left),
            };
        });
        check("mac: the sidebar docks on the trailing edge",
            side.declared && side.gapRight <= 1 && side.gapLeft > 1, JSON.stringify(side));
        check("mac: and it carries no control offering to move it",
            !(await page.$(".toc-flip-btn")), "the flip button is still on the panel");

        // ── tocToggleInBar ────────────────────────────────────────────
        // One control, not two a few pixels apart. Both of the panel's own are
        // gone, and the arm is the control page below, where all three exist.
        check("mac: the panel carries no hide button of its own",
            !(await page.$(".toc-hide-btn")), "the panel's hide button is still there");

        await tocButton.click();
        const shutAgain = await settled(false);
        check("mac: pressing it again puts the sidebar away",
            !shutAgain.open && !shutAgain.panelOnScreen, JSON.stringify(shutAgain));
        check("mac: and no reveal tab appears where the panel was",
            !(await page.$(".toc-toggle-tab")), "the reveal tab is still on the page");

        // The hover preview is the half that must SURVIVE the withdrawal: the
        // reveal tab is what used to carry it, so a build that simply deleted
        // the tab would leave the bar's button with a click and nothing else.
        // Real pointer events (`hover`), because this is a handler race between
        // the button and the panel and a dispatched mouseenter would prove
        // nothing about which one wins. The pointer is moved AWAY first: the
        // click above left it on the button, and hovering where it already is
        // fires no mouseenter, so the check would be reading a flyout that was
        // never asked for.
        await page.mouse.move(20, 400);
        await page.waitForTimeout(150);
        await tocButton.hover();
        await page.waitForTimeout(400);
        const flown = await page.evaluate(() => {
            const panel = document.querySelector(".toc-panel");
            const bar = document.querySelector(".editor-topbar");
            const box = panel.getBoundingClientRect();
            return {
                flyout: panel.classList.contains("toc-panel--flyout"),
                onScreen: getComputedStyle(panel).visibility !== "hidden"
                    && box.width > 0 && box.left < window.innerWidth,
                // Transient, not docked: the body classes that make room for a
                // docked panel must stay off, or this "preview" has quietly
                // reflowed the document.
                docked: document.body.classList.contains("toc-open")
                    || document.body.classList.contains("toc-overlay-open"),
                // Under the trigger it hangs off, not parked where the reveal
                // tab used to be.
                belowBar: box.top >= bar.getBoundingClientRect().bottom - 0.5,
            };
        });
        check("mac: resting on the bar's button flies the sidebar out",
            flown.flyout && flown.onScreen, JSON.stringify(flown));
        check("mac: as a preview, without docking it",
            !flown.docked && flown.belowBar, JSON.stringify(flown));

        // And it retracts, or the preview is a panel that never goes away.
        await page.mouse.move(20, 400);
        await page.waitForTimeout(600);
        check("mac: and it retracts when the pointer leaves",
            !(await page.evaluate(() => document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"))),
            "the flyout stayed up");

        // Mid-drag, the same hover must still fly it out: a block dragged with
        // the sidebar put away is refiled into it by resting on the bar's
        // button, and the interaction shield that covers the page for the
        // drag has to leave that button open. The trigger differs per
        // arrangement (the reveal tab elsewhere), so this pins the bar's.
        const grip = await page.evaluate(() => {
            const p = [...document.querySelectorAll(".ProseMirror > p")].find((el) => el.textContent.length > 8);
            if (!p) return null;
            const r = p.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + Math.min(14, r.height / 2) };
        });
        check("mac: the fixture has a paragraph to drag", !!grip);
        if (grip) {
            await page.mouse.move(grip.x, grip.y);
            await page.waitForTimeout(150);
            const handle = await page.evaluate(() => {
                const p = [...document.querySelectorAll(".ProseMirror > p")].find((el) => el.textContent.length > 8);
                const marker = p?.querySelector(".heading-fold-marker");
                if (!marker) return null;
                const r = marker.getBoundingClientRect();
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                return { x: cx, y: cy, hit: !!document.elementFromPoint(cx, cy)?.closest(".heading-fold-marker") };
            });
            check("mac: the paragraph's gutter handle is under the pointer", !!handle && handle.hit, JSON.stringify(handle));
            if (handle && handle.hit) {
                const btn = await tocButton.boundingBox();
                await page.mouse.move(handle.x, handle.y);
                await page.mouse.down();
                await page.mouse.move(handle.x + 8, handle.y + 8); // cross the drag threshold
                await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 8 });
                await page.waitForTimeout(450);
                const midDrag = await page.evaluate(() => ({
                    dragging: document.body.classList.contains("block-dragging"),
                    flyout: document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"),
                }));
                check("mac: resting on the bar's button MID-DRAG flies the sidebar out too",
                    midDrag.dragging && midDrag.flyout, JSON.stringify(midDrag));
                await page.keyboard.press("Escape");
                await page.mouse.up();
                await page.mouse.move(20, 400);
                await page.waitForTimeout(600);
            }
        }

        // A toolbar dropdown opening takes the flyout down with it, rather
        // than being drawn across a panel that is still there. Both are the
        // editor answering "what else is here", and two of them on screen at
        // once is it answering twice; the z-order that keeps a menu on top
        // (`toolbarMenu`) is what made the overlap look deliberate.
        //
        // The MENU IS OPENED FROM THE KEYBOARD, and that is the whole of what
        // makes this a check rather than decoration. The flyout is a hover
        // preview and retracts on its own the moment the pointer leaves its
        // trigger, so clicking a menu moves the pointer away and the flyout
        // goes whether or not anything swept it: written that way it passed
        // with the sweep deleted. Opening from the keyboard leaves the pointer
        // resting on the trigger, where the flyout has every reason to stay,
        // so a retraction can only be the menu's doing.
        await page.mouse.move(20, 400);
        await page.waitForTimeout(300);
        await tocButton.hover();
        await page.waitForTimeout(400);
        const beforeMenu = await page.evaluate(() =>
            document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"));
        // The instrument first: a flyout that never came out is dismissed by
        // nothing, and the check below would read the same as a pass.
        check("mac: the flyout is out before a menu is opened", beforeMenu, `${beforeMenu}`);

        const opened = await page.evaluate(() => {
            const trigger = document.querySelector(".editor-topbar .tb-fmt-wrap > button");
            if (!trigger) { return { reached: false }; }
            trigger.focus();
            trigger.dispatchEvent(new KeyboardEvent("keydown", {
                key: "ArrowDown", bubbles: true, cancelable: true,
            }));
            return { reached: true };
        });
        check("mac: a toolbar menu trigger was there to open", opened.reached, JSON.stringify(opened));
        await page.waitForTimeout(500);
        const afterMenu = await page.evaluate(() => ({
            menuOpen: [...document.querySelectorAll(".tb-fmt-menu")]
                .some((m) => m.style.display === "flex"),
            flyout: document.querySelector(".toc-panel").classList.contains("toc-panel--flyout"),
        }));
        check("mac: opening a toolbar menu retracts the flyout",
            afterMenu.menuOpen && !afterMenu.flyout, JSON.stringify(afterMenu));
        // Put the page back: this suite goes on to read other chrome, and a
        // menu left open is a state every check after this one inherits.
        await page.keyboard.press("Escape");
        await page.mouse.move(20, 400);
        await page.waitForTimeout(300);
    }

    // ── formattingInSecondRow ─────────────────────────────────────────
    // The partition itself is unit-tested (toolbarRegistry.test.ts); what only
    // a real page can answer is whether the two holders actually received it.
    check("mac: the top bar's left zone is empty, leaving the titlebar row to the window",
        mac.leftZone.length === 0, JSON.stringify(mac.leftZone));
    check("mac: the top bar keeps only the controls that read the document",
        JSON.stringify(mac.rightZone) === JSON.stringify(["styleCheck", "find", "settings", "toc"]),
        JSON.stringify(mac.rightZone));
    check("mac: every editing control is in the dock instead",
        ["format", "bold", "italic", "link", "listMenu", "quote", "codeBlock", "table", "image"]
            .every((id) => mac.dock.includes(id)),
        JSON.stringify(mac.dock));
    // The dock takes no placement config, so the controls that ship hidden on
    // the top bar are here too. This is the half that separates "moved the
    // bar" from "all the formatting controls".
    check("mac: the dock also carries the controls that ship hidden on the bar",
        ["strikethrough", "highlight", "inlineCode", "horizontalRule", "math", "footnote", "clearFormatting"]
            .every((id) => mac.dock.includes(id)),
        JSON.stringify(mac.dock));
    check("mac: no item is on both surfaces",
        mac.dock.every((id) => !mac.rightZone.includes(id)),
        JSON.stringify({ dock: mac.dock, right: mac.rightZone }));

    // WHERE the second holder is, which is the half of this arrangement that
    // only a laid-out page can answer. The three checks below are one claim in
    // three parts: the row is inside the bar, the button that opens it is not,
    // and opening it makes the bar taller.
    //
    // The last one is the load-bearing one. Everything that keeps chrome off
    // the text — the content's top padding, the find bar's offset, heading
    // scroll margins, and `safeAreaTop()` behind every popup's placement —
    // measures the bar's own box. A row that opened without changing that
    // measurement would look right on the day it landed and would be painted
    // over by the first popup that opened into it, so "the bar grew" is the
    // property to hold rather than any particular pixel.
    const barShape = () => page.evaluate(() => {
        const bar = document.querySelector(".editor-topbar");
        const row = document.querySelector(".tb-dock");
        const toggle = document.querySelector(".tb-dock-toggle");
        const zone = document.querySelector(".tb-zone--right");
        const placed = [...zone?.querySelectorAll(".tb-item") ?? []]
            .find((el) => !["syncConflict", "logseq", "debug"].includes(el.dataset.itemId));
        return {
            rowInBar: row?.parentElement === bar,
            toggleInBar: !!toggle?.closest(".editor-topbar") && !toggle?.closest(".tb-dock"),
            // Ahead of every PLACEABLE item. The two status badges are pinned
            // to the front of the zone by the layout controller and are not
            // the partition's, so the first `.tb-item` is not what this asks
            // about: the first one the partition put there is.
            toggleLeadsTopBar: !!toggle && !!placed
                && (toggle.compareDocumentPosition(placed) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
            barHeight: bar?.getBoundingClientRect().height ?? 0,
        };
    });
    // Driven through the page's own click rather than a synthesized event.
    // `bindActivate` answers the FIRST of mousedown or click, so a probe that
    // sends both toggles twice and measures the state it started in, which
    // reads exactly like a row that does not move the bar.
    const beforeOpen = await barShape();
    await page.locator(".tb-dock-toggle").click();
    await page.waitForTimeout(200);
    const afterOpen = await barShape();
    const rowGeometry = { ...beforeOpen, collapsed: beforeOpen.barHeight, expanded: afterOpen.barHeight };
    // Put it back, so the checks after this one meet the page as they expect it.
    await page.locator(".tb-dock-toggle").click();
    await page.waitForTimeout(200);
    check("mac: the formatting row is a row of the top bar, not a strip of its own",
        rowGeometry.rowInBar, JSON.stringify(rowGeometry));
    check("mac: its toggle is in the bar itself, not in the row it opens",
        rowGeometry.toggleInBar, JSON.stringify(rowGeometry));
    check("mac: the toggle leads the top bar, ahead of the items the partition placed",
        rowGeometry.toggleLeadsTopBar, JSON.stringify(rowGeometry));
    check("mac: opening the row makes the bar taller, so everything that measures it follows",
        rowGeometry.expanded > rowGeometry.collapsed, JSON.stringify(rowGeometry));

    // ── fixedToolbarLayout ─────────────────────────────────────────────
    check("mac: no reveal tab, because the bar never hides", !mac.showTab);
    // The typography rows live in the gear here, so the item that would open a
    // second dropdown beside it is not built. Asserted with the gear rows
    // below, which is the other half: absent from the bar AND present in the
    // menu, or this passes on a build that simply lost the controls.
    check("mac: no separate font item, because its rows are in the gear",
        !mac.items.includes("fontPreset"), JSON.stringify(mac.items));
    // The other direction of the same rule: a capability the host DOES declare
    // keeps its item. Without this the suite would pass a build that gated
    // everything, which is the failure a gating test is most likely to have.
    check("mac: the Image item is present, because the shell declares imageUpload",
        mac.items.includes("image"), JSON.stringify(mac.items));

    // Gear menu: exactly the rows this surface keeps, in table order. The
    // layout rows are gone because `fixedToolbarLayout` withdraws them, and VS
    // Code's settings, keybindings and release rows because no capability
    // names them; the shell's own Settings row stays because it does.
    const gearBtn = '[data-item-id="settings"] .tb-fmt-btn';
    const gearMenu = '[data-item-id="settings"] .tb-settings-menu';
    await page.locator(gearBtn).click();
    await page.waitForTimeout(OPEN_WAIT);
    const gear = await page.$eval(gearMenu, (menu) => ({
        labels: [...menu.querySelectorAll(".tb-fmt-item")].map((el) => el.textContent),
        kinds: [...menu.children].map((el) =>
            el.classList.contains("tb-menu-sep") ? "sep" : el.classList.contains("tb-fmt-item") ? "item" : el.className),
        hasSizeRow: !!menu.querySelector(".tb-font-size-row"),
        hasWidthRow: !!menu.querySelector(".tb-seg-btn"),
    }));
    // The shell has a Settings window (`appPreferences`), so its row belongs;
    // VS Code's own settings and keybindings rows do not, and neither does the
    // release page. This asserts both directions in one list.
    check("mac: gear menu offers the typography presets, the cheatsheet and the shell's own Settings",
        JSON.stringify(gear.labels) === JSON.stringify(
            ["Sans serif", "Serif", "Monospace",
             "Show Keyboard Shortcuts", "Birta Writer Settings"]),
        JSON.stringify(gear.labels));
    // The typography rows stay at the TOP with the layout rows withdrawn. They
    // are what a reader opens this menu for, and the rule that placed them
    // ("after the layout rows") has to survive there being none.
    check("mac: the typography rows are still first, not pushed below the cheatsheet",
        gear.labels.indexOf("Serif") < gear.labels.indexOf("Show Keyboard Shortcuts"),
        JSON.stringify(gear.labels));
    check("mac: and neither layout row, because the arrangement is not the user's",
        !gear.labels.includes("Customize Toolbar") && !gear.labels.includes("Hide Toolbar"),
        JSON.stringify(gear.labels));
    // Editor font needs an editor font to inherit and the width segments need
    // a pane wide enough for a measure to be a choice; the shell declares
    // neither, so neither row is here even though both would be in VS Code.
    check("mac: the gear offers no Editor-font row and no width segments",
        !gear.labels.includes("Editor font") && !gear.hasWidthRow,
        JSON.stringify({ labels: gear.labels, hasWidthRow: gear.hasWidthRow }));
    check("mac: the size stepper came with them", gear.hasSizeRow, JSON.stringify(gear.kinds));

    // The point of moving the rows rather than rebuilding them: the palette
    // and slash-menu commands run the SAME control, so a font pick from a
    // command still reaches the document. Without this the suite would pass a
    // build where the gear looks right and `/serif` does nothing.
    const fontBefore = await page.evaluate(
        () => document.documentElement.style.getPropertyValue("--content-font-family"));
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "fontMono" }, "*"));
    await page.waitForTimeout(250);
    const fontAfter = await page.evaluate(
        () => document.documentElement.style.getPropertyValue("--content-font-family"));
    check("mac: a font command still applies with the rows in the gear",
        fontAfter !== fontBefore && /mono/i.test(fontAfter), JSON.stringify({ fontBefore, fontAfter }));

    // …and the checkmark in the gear followed it, so the menu and the document
    // never disagree about which preset is on.
    await page.locator(gearBtn).click();
    await page.waitForTimeout(OPEN_WAIT);
    const checked = await page.$eval(gearMenu, (menu) =>
        [...menu.querySelectorAll(".tb-fmt-item")]
            .filter((el) => el.getAttribute("aria-checked") === "true")
            .map((el) => el.textContent));
    check("mac: …and the gear's checkmark moved with it",
        JSON.stringify(checked) === JSON.stringify(["Monospace"]), JSON.stringify(checked));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    // Asserted as what it means rather than through "starts with an item":
    // with the layout rows withdrawn the menu opens on the size stepper, which
    // is a row and not a separator, and the proxy would have called that a
    // dangling one.
    check("mac: gear menu separates the groups without dangling one",
        gear.kinds[0] !== "sep" && gear.kinds[gear.kinds.length - 1] !== "sep"
            && !gear.kinds.join(",").includes("sep,sep"),
        JSON.stringify(gear.kinds));

    // The withdrawal has to reach the COMMAND, not only the menu that offers
    // it: a row removed from the gear while the command still ran would leave
    // customize mode one palette pick away, on a layout with nothing to
    // customize. Posted the same way the palette posts it.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "customizeToolbar" }, "*"));
    await page.evaluate(() =>
        window.postMessage({ type: "editorCommand", command: "hideToolbar" }, "*"));
    await page.waitForTimeout(250);
    const afterWithdrawn = await page.evaluate(() => ({
        tray: !!document.querySelector(".tb-hidden-tray"),
        barHidden: document.body.classList.contains("toolbar-hidden"),
        dock: !!document.querySelector(".tb-dock"),
    }));
    check("mac: the customizeToolbar command opens no tray",
        !afterWithdrawn.tray, JSON.stringify(afterWithdrawn));
    check("mac: the hideToolbar command leaves the bar alone",
        !afterWithdrawn.barHidden, JSON.stringify(afterWithdrawn));
    check("mac: and the dock is still there afterwards",
        afterWithdrawn.dock, JSON.stringify(afterWithdrawn));

    const allItems = await itemIds();
    check("mac: no host-bound item anywhere in the DOM",
        GATED_ITEMS.every((id) => !allItems.includes(id)), JSON.stringify(allItems));

    // Shortcuts help: the cheatsheet opens, without the Edit Keyboard
    // Shortcuts footer (a keybindings UI the host does not have).
    await page.locator(gearBtn).click();
    await page.waitForTimeout(OPEN_WAIT);
    await page.locator(`${gearMenu} .tb-fmt-item`, { hasText: "Show Keyboard Shortcuts" }).dispatchEvent("mousedown");
    await page.waitForTimeout(400);
    const help = await page.evaluate(() => ({
        open: !!document.querySelector(".shortcuts-help--visible"),
        footer: !!document.querySelector(".shortcuts-help__footer"),
    }));
    check("mac: the shortcuts cheatsheet still opens", help.open, JSON.stringify(help));
    check("mac: the cheatsheet has no Edit Keyboard Shortcuts footer", !help.footer, JSON.stringify(help));

    // The host's own shortcuts print in the cheatsheet, under the menu each one
    // comes from, and rendered by the same helper as every other row rather
    // than as a raw string in the same column.
    //
    // The sections are read off the DECLARATION rather than named here. A
    // heading spelled in this file is a string outside the vocabulary of the
    // thing it guards, so renaming one on the host side leaves a check that
    // either fails for a reason saying nothing about the panel, or silently
    // measures nothing.
    const hostRows = await page.evaluate(() => {
        const sectioned = (window.__i18n?.host?.shortcuts ?? []).filter((s) => s.section);
        const declared = [...new Set(sectioned.map((s) => s.section))];
        const heads = [...document.querySelectorAll(".shortcuts-help__section-title")];
        const found = {};
        for (const name of declared) {
            const section = heads.find((h) => h.textContent === name);
            if (!section) { continue; }
            const rows = [];
            for (let el = section.nextElementSibling;
                 el && !el.classList.contains("shortcuts-help__section-title");
                 el = el.nextElementSibling) {
                const chip = el.querySelector("kbd");
                if (chip) { rows.push(chip.textContent); }
            }
            found[name] = rows;
        }
        return { declared, expected: sectioned.length, found };
    });
    const sectionNames = hostRows?.declared ?? [];
    const printed = Object.values(hostRows?.found ?? {}).flat();
    check("mac: the cheatsheet prints a section for every menu the host binds keys in",
        sectionNames.length > 0 && Object.keys(hostRows.found).length === sectionNames.length,
        JSON.stringify({ declared: sectionNames, found: Object.keys(hostRows?.found ?? {}) }));
    // Every declared key, not merely some: a count compared against the
    // declaration is what a floor cannot be, since a panel that dropped all but
    // one row per section would clear any floor these sections can set.
    check("mac: …with every key the host declares under them",
        printed.length === hostRows?.expected,
        JSON.stringify({ expected: hostRows?.expected, printed: printed.length }));
    check("mac: …rendered as glyphs by the shared helper, not the raw notation",
        printed.some((k) => /⌘/.test(k)) && !printed.some((k) => /Mod-/.test(k)),
        JSON.stringify(printed.slice(0, 8)));
    // The chord a menu key equivalent gives a command reaches the tooltip of
    // the control that runs it: the link button says ⌘K here and says nothing
    // inside VS Code, where the binding is the user's and unreadable from the
    // page (webview/commandChords.ts).
    //
    // Read off `aria-label` rather than `title`: `applyTooltip` REMOVES the
    // title attribute and draws the tooltip itself, so a probe reading `title`
    // finds nothing on every button in the bar and reports the tooltip missing
    // when it is only somewhere else. The accessible name is the same string
    // minus the parenthesised chord, so this asserts both halves at once: the
    // key is in the tooltip, and it is NOT in the name a screen reader reads.
    const linkTitle = await page.evaluate(() => {
        const btn = [...document.querySelectorAll(".tb-btn")]
            .find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Insert/Edit Link"));
        if (!btn) { return null; }
        btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
        const tip = document.querySelector(".ui-tooltip, [class*='tooltip']");
        return { name: btn.getAttribute("aria-label"), tip: tip?.textContent ?? null };
    });
    check("mac: the link button's tooltip prints the key the app binds for it",
        !!linkTitle && /⌘K/.test(linkTitle.tip ?? ""), JSON.stringify(linkTitle));
    check("mac: …and the key stays out of the button's accessible name",
        !!linkTitle && linkTitle.name === "Insert/Edit Link", JSON.stringify(linkTitle));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Typing works.
    await page.locator(".milkdown .ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" appended", { delay: 30 });
    await page.waitForTimeout(600);
    const typed = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update").map((m) => m.content);
        return updates[updates.length - 1] ?? "";
    });
    check("mac: typing reaches the document (an update carries the text)", /Some text\. appended/.test(typed),
        JSON.stringify(typed.slice(0, 80)));

    // Slash menu: no gated row, even under "Show all commands" or by search.
    const SLASH = "#md-slash-menu";
    const slashLabels = () => page.$$eval(`${SLASH} .slash-menu-item-label`, (els) => els.map((e) => e.textContent));
    // A fresh mount per open, and the "/" typed after a space at the end of
    // the first paragraph (a slash construct after whitespace), so no caret
    // move is needed and each open is independent of the last.
    async function openSlash(query, { expectRows = true } = {}) {
        await mount("index.html");
        await page.locator(".milkdown .ProseMirror p").first().click();
        await page.keyboard.press("End");
        await page.keyboard.type(` /${query}`, { delay: 60 });
        // A query that matches nothing keeps the menu hidden, which is itself
        // the answer the search checks want, so only the browse open waits.
        if (expectRows) { await page.waitForSelector(SLASH, { state: "visible", timeout: 10000 }); }
        await page.waitForTimeout(300);
    }
    await openSlash("");
    await page.locator(`${SLASH} .slash-menu-footer-hint`).click();
    await page.waitForTimeout(150);
    let labels = await slashLabels();
    // Rows bound to a capability the Mac shell does NOT provide. "Ask Agent" is
    // deliberately absent from this list: the shell runs one now, so its row
    // belongs, and moving it to the offered set below is the point.
    // "Check style" and "Highlight note markers" are deliberately NOT here any
    // more: both are answered inside the page, so they are the editor's own
    // rows and belong on every surface (they are asserted present below).
    const GATED_LABELS = ["Edit Raw Markdown", "Settings", "Edit Keyboard Shortcuts",
        "Lock Edits (Read-only)",
        "Editor Font", "Full Width", "Fixed Width"];
    check("mac: Show all commands lists no row bound to a capability the shell lacks",
        GATED_LABELS.every((l) => !labels.includes(l)), JSON.stringify(labels.filter((l) => GATED_LABELS.includes(l))));
    check("mac: Show all commands still lists the editor's own rows",
        ["Table", "Code Block", "Bold", "Find"].every((l) => labels.includes(l)), JSON.stringify(labels));
    // The two rows that moved out of GATED_LABELS, asserted present rather than
    // merely dropped: a build that withdrew them again would otherwise satisfy
    // the list above by offering less.
    check("mac: the checks the page computes for itself are offered here",
        ["Check style", "Highlight note markers"].every((l) => labels.includes(l)), JSON.stringify(labels));
    // The other half of the gate: a capability the shell DOES declare has to
    // put its row back, or the check above would pass on a page that offers
    // nothing at all.
    check("mac: Show all commands lists the rows the shell's own capabilities earn",
        ["Image", "Ask Agent", "Check spelling", "Check grammar"].every((l) => labels.includes(l)),
        JSON.stringify(labels));
    // The sidebar's row, present because the shell declares `toc`. Its label is
    // dynamic (Hide/Show), so this asks for the subject rather than for a
    // spelling of the state it happens to be in.
    //
    // ONE row, not the two every other surface gets: Swap Table of Contents
    // Side is withdrawn here (`fixedTocSide`), and the pair is asserted
    // together because "the sidebar has rows" and "the side is not offered" are
    // separate claims and a count of two satisfies neither.
    const tocRows = labels.filter((l) => /Table of Contents/.test(l));
    check("mac: the sidebar's row is in the slash menu",
        tocRows.length === 1 && !/Side|Move/.test(tocRows[0] ?? ""), JSON.stringify(tocRows));
    check("mac: and the side is not offered anywhere in it",
        !labels.some((l) => /Move Table of Contents|Swap Table of Contents/.test(l)),
        JSON.stringify(tocRows));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    // Search is the other way in, and a withdrawn row must not be reachable
    // through it either. "spell" is deliberately NOT in this list any more:
    // this shell answers spelling now, so Check spelling is a row it earns, and
    // it is asserted PRESENT in the earned-rows check above.
    for (const [q, label] of [["raw", "Edit Raw Markdown"], ["setting", "Settings"], ["lock", "Lock Edits (Read-only)"]]) {
        await openSlash(q, { expectRows: false });
        labels = await page.evaluate((sel) => {
            const menu = document.querySelector(sel);
            if (!menu || getComputedStyle(menu).display === "none") { return []; }
            return [...menu.querySelectorAll(".slash-menu-item-label")].map((e) => e.textContent);
        }, SLASH);
        check(`mac: searching "/${q}" does not surface "${label}"`, !labels.includes(label), JSON.stringify(labels));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(150);
    }

    // A chord for a gated command is inert: the host's editorCommand message
    // (what a keybinding turns into) for editRawMarkdown posts nothing.
    const before = await page.evaluate(() => window.__posted.filter((m) => m.type === "switchToTextEditor").length);
    await page.evaluate(() => {
        window.postMessage({ type: "editorCommand", command: "editRawMarkdown" }, "*");
        window.postMessage({ type: "editorCommand", command: "toggleReadOnly" }, "*");
    });
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
        switched: window.__posted.filter((m) => m.type === "switchToTextEditor").length,
        readOnly: document.body.classList.contains("read-only") || !!document.querySelector(".ProseMirror[contenteditable='false']"),
    }));
    check("mac: editRawMarkdown via editorCommand posts no switchToTextEditor", after.switched === before,
        `before=${before} after=${after.switched}`);
    check("mac: toggleReadOnly via editorCommand leaves the editor editable", !after.readOnly);

    // ── The dock's two states, and the row's geometry ──────────────────
    // Everything below needs a layout engine: what is drawn, what scrolls,
    // and whether a dropdown escapes the box that scrolls it.
    const dockSel = ".tb-dock";
    const rowSel = ".tb-dock-row";
    const toggleSel = ".tb-dock-toggle";

    const dockState = () => page.evaluate(() => {
        const dock = document.querySelector(".tb-dock");
        const row = document.querySelector(".tb-dock-row");
        const bar = document.querySelector(".editor-topbar");
        const shown = (el) => !!el && !!el.getClientRects().length;
        return {
            expanded: dock?.dataset.expanded,
            rowShown: shown(row),
            toggleShown: shown(document.querySelector(".tb-dock-toggle")),
            glyph: document.querySelector(".tb-dock-glyph")?.textContent,
            overflows: row ? row.scrollWidth > row.clientWidth + 1 : null,
            saved: window.__state?.formattingRowExpanded,
            barHeight: bar?.getBoundingClientRect().height ?? null,
        };
    });

    const collapsed = await dockState();
    check("mac: the row starts collapsed, with only the T in the bar",
        collapsed.expanded === "false" && collapsed.toggleShown && !collapsed.rowShown
            && collapsed.glyph === "T",
        JSON.stringify(collapsed));

    await page.locator(toggleSel).click();
    await page.waitForTimeout(200);
    const expanded = await dockState();
    check("mac: clicking the T opens the row",
        expanded.expanded === "true" && expanded.rowShown,
        JSON.stringify(expanded));
    // And the bar is what grew. Collapsed the row must not merely be invisible
    // but absent from the bar's box, or the content below stays pushed down
    // around a row nobody can see.
    check("mac: opening it grows the bar, closing it gives the height back",
        expanded.barHeight > collapsed.barHeight,
        JSON.stringify({ collapsed: collapsed.barHeight, expanded: expanded.barHeight }));

    // The four checks that stood here measured the toggle's chevron: that it
    // was drawn at rest, that hovering did not change its width, and that the
    // row therefore did not shift sideways under the pointer. The chevron is
    // gone, so they are gone with it rather than repointed at something else.
    //
    // What replaces the geometry half is cheaper and holds the same property:
    // the toggle's box does not change when the pointer arrives on it. That is
    // still worth asserting, because it is a button whose contents could grow
    // again, and a control that resizes under the pointer is one you can miss
    // by arriving at it.
    const hoverShift = await (async () => {
        const boxOf = () => page.evaluate(() => {
            const t = document.querySelector(".tb-dock-toggle");
            const first = document.querySelector(".tb-dock-row .tb-item");
            return {
                toggle: Math.round(t.getBoundingClientRect().width),
                firstItemLeft: first ? Math.round(first.getBoundingClientRect().left) : null,
            };
        });
        await page.mouse.move(5, 5);
        await page.waitForTimeout(250);
        const away = await boxOf();
        await page.locator(toggleSel).hover();
        await page.waitForTimeout(300);
        const over = await boxOf();
        return { away, over };
    })();
    check("mac: the row it could push is really there to be pushed",
        hoverShift.away.firstItemLeft !== null, JSON.stringify(hoverShift));
    check("mac: hovering the toggle moves nothing in the row",
        hoverShift.over.toggle === hoverShift.away.toggle
            && hoverShift.over.firstItemLeft === hoverShift.away.firstItemLeft,
        JSON.stringify(hoverShift));
    check("mac: and the toggle carries no chevron beside the letter",
        (await page.evaluate(() => !document.querySelector(".tb-dock-chevron"))),
        "a chevron is present");
    check("mac: and the choice was written to the view-state bag",
        expanded.saved === true, JSON.stringify(expanded));

    // The tip that hover just raised, which is still on screen: it names the
    // toggle, so it has to be UNDER the toggle.
    //
    // The pull the other way is the reason `position()` has a floor at all:
    // the bar paints over the tooltip, so a tip anywhere in the bar's box
    // would be invisible. That floor is right for an anchor in the document
    // and backwards for one in the bar, and a second row is what made the
    // difference visible: the tip cleared both rows and landed over the text,
    // pointing at nothing.
    //
    // Three assertions, because two of them are only sound together. "Near
    // its anchor" and "inside the bar's box" would be satisfied by a tip
    // nobody can see; the z-order is what says the overlap is legible.
    //
    // z-index IS paint order for this pair, and the last assertion checks the
    // premise rather than assuming it: both are `position: fixed` children of
    // <body>, so they share the root stacking context with nothing between
    // them. Either one acquiring a positioned ancestor breaks that, and the
    // check is what will say so.
    const tipBox = await page.evaluate(() => {
        const tip = document.querySelector(".custom-tooltip");
        const toggle = document.querySelector(".tb-dock-toggle");
        const bar = document.querySelector(".editor-topbar");
        if (!tip || !toggle || !bar) return null;
        const t = tip.getBoundingClientRect();
        const b = toggle.getBoundingClientRect();
        const bar_ = bar.getBoundingClientRect();
        return {
            shown: getComputedStyle(tip).display !== "none" && t.height > 0,
            text: tip.textContent,
            gap: Math.round(t.top - b.bottom),
            belowBar: Math.round(t.top - bar_.bottom),
            barHeight: Math.round(bar_.height),
            tipZ: Number.parseInt(getComputedStyle(tip).zIndex, 10),
            barZ: Number.parseInt(getComputedStyle(bar).zIndex, 10),
            tipFixed: getComputedStyle(tip).position === "fixed",
            tipInBody: tip.parentElement === document.body,
            barFixed: getComputedStyle(bar).position === "fixed",
            barInBody: bar.parentElement === document.body,
        };
    });
    check("mac: hovering the toggle raises its tooltip", !!tipBox?.shown,
        JSON.stringify(tipBox));
    check("mac: the tooltip hangs off the toggle, not off the whole two-row bar",
        tipBox && tipBox.gap >= 0 && tipBox.gap <= 12 && tipBox.belowBar < 0,
        JSON.stringify(tipBox));
    check("mac: and it paints over the bar it now overlaps",
        tipBox && tipBox.tipZ > tipBox.barZ
            && tipBox.tipFixed && tipBox.tipInBody
            && tipBox.barFixed && tipBox.barInBody,
        JSON.stringify(tipBox));

    // Narrow enough that the row cannot fit: it must SCROLL rather than wrap,
    // clip silently, or push the window wider than the viewport.
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 420, height: viewport?.height ?? 800 });
    await page.waitForTimeout(250);
    const narrow = await dockState();
    const bodyOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("mac: a window too narrow for the row makes the row scroll",
        narrow.overflows === true, JSON.stringify(narrow));
    check("mac: and never the page itself", bodyOverflow);
    const scrolled = await page.evaluate(() => {
        const row = document.querySelector(".tb-dock-row");
        row.scrollLeft = row.scrollWidth;
        return row.scrollLeft > 0;
    });
    // The chevrons. They exist because the scroll is otherwise discoverable
    // only by trying it: the scrollbar is hidden, so a row that overflows looks
    // like a row that ends at the window's edge.
    //
    // Asserted in three parts, because each is a different way to get this
    // wrong: whether they appear at all when there is somewhere to go, whether
    // the one pointing nowhere stays away, and whether clicking one actually
    // moves the row. A pair that is simply always visible passes the first on
    // its own.
    // Back to the start first: the check above scrolls the row to its end to
    // prove the last control is reachable, so without this the "at the start"
    // claim below is made about a row that is at its end, and is false for the
    // right reason. `instant` rather than smooth, so the assertion that follows
    // is not racing an animation.
    await page.evaluate(() => {
        document.querySelector(".tb-dock-row").scrollTo({ left: 0, behavior: "instant" });
    });
    await page.waitForTimeout(150);
    const chevronsNarrow = await page.evaluate(() => {
        const row = document.querySelector(".tb-dock-row");
        const start = document.querySelector(".tb-dock-scroll--start");
        const end = document.querySelector(".tb-dock-scroll--end");
        const shown = (el) => !!el && !!el.getClientRects().length;
        return {
            overflows: row.scrollWidth > row.clientWidth + 1,
            scrollLeft: row.scrollLeft,
            startShown: shown(start),
            endShown: shown(end),
        };
    });
    check("mac: at the start of an overflowing row, only the forward chevron shows",
        chevronsNarrow.overflows && chevronsNarrow.endShown && !chevronsNarrow.startShown,
        JSON.stringify(chevronsNarrow));

    await page.locator(".tb-dock-scroll--end").click();
    await page.waitForTimeout(500);
    const chevronsScrolled = await page.evaluate(() => {
        const row = document.querySelector(".tb-dock-row");
        const start = document.querySelector(".tb-dock-scroll--start");
        const shown = (el) => !!el && !!el.getClientRects().length;
        return { scrollLeft: row.scrollLeft, startShown: shown(start) };
    });
    check("mac: clicking it scrolls the row",
        chevronsScrolled.scrollLeft > chevronsNarrow.scrollLeft,
        JSON.stringify({ before: chevronsNarrow.scrollLeft, after: chevronsScrolled.scrollLeft }));
    check("mac: and the back chevron appears once there is something behind you",
        chevronsScrolled.startShown, JSON.stringify(chevronsScrolled));

    check("mac: the last control can be reached by scrolling", scrolled);

    // The chevron's SHAPE, which jsdom cannot answer and which is the whole of
    // what changed: it was a full-height strip flush against the window frame,
    // and it is now a button the size of the controls it sits over, centred on
    // the row and held off the edge. Each of those is a separate way to get it
    // wrong, so each is a separate clause.
    //
    // Compared against a real toolbar item rather than against numbers written
    // here: the claim is "the same size as its neighbours", and a hardcoded 24
    // would keep passing on the day the items changed height.
    //
    // The START chevron, and that is not arbitrary: the row was just scrolled
    // to its end, so the FORWARD one is correctly hidden and a hidden element
    // reports a zero rect, which fails every clause below for the wrong reason.
    // The check above has already asserted this one is showing.
    const chevronShape = await page.evaluate(() => {
        const btn = document.querySelector(".tb-dock-scroll--start");
        const row = document.querySelector(".tb-dock-row");
        const item = row.querySelector(".tb-item .ui-btn");
        if (!btn || !item || !btn.getClientRects().length) { return null; }
        const e = btn.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        const i = item.getBoundingClientRect();
        const fade = document.querySelector(".tb-dock-fade--start");
        const f = fade?.getBoundingClientRect();
        return {
            height: e.height,
            itemHeight: i.height,
            rowHeight: r.height,
            centreOffset: Math.abs((e.top + e.bottom) / 2 - (r.top + r.bottom) / 2),
            // The leading edge here, since this is the leading chevron.
            insetFromFrame: e.left - r.left,
            fadeWidth: f ? f.width : 0,
            buttonWidth: e.width,
            fadeShown: !!fade && !!fade.getClientRects().length,
        };
    });
    // These two do NOT discriminate on this fixture, and saying so is the
    // point: the row's content box happens to be exactly the item height here,
    // so the old full-height strip measured 24 as well and passes both. They
    // are kept because they are the property actually wanted, and they would
    // catch a strip in a row that had grown taller. The clauses below are the
    // ones that fail against the old chevron.
    check("mac: the scroll chevron is the same height as the controls it sits over",
        chevronShape !== null && Math.abs(chevronShape.height - chevronShape.itemHeight) <= 1,
        JSON.stringify(chevronShape));
    check("mac: and is no taller than the row",
        chevronShape !== null && chevronShape.height <= chevronShape.rowHeight,
        JSON.stringify(chevronShape));
    check("mac: it is centred on the row",
        chevronShape !== null && chevronShape.centreOffset <= 1,
        JSON.stringify(chevronShape));
    check("mac: and inset from the window frame rather than flush against it",
        chevronShape !== null && chevronShape.insetFromFrame > 0,
        JSON.stringify(chevronShape));
    // The fade is its own element now, and has to be WIDER than the button or
    // the item underneath meets a hard edge instead of dissolving.
    check("mac: the fade behind it is shown and wider than the button",
        chevronShape !== null && chevronShape.fadeShown
            && chevronShape.fadeWidth > chevronShape.buttonWidth,
        JSON.stringify(chevronShape));

    // Hidden WITH its chevron. A gradient left on an edge with nothing past it
    // says the row scrolls when it does not, and `hidden` on the button alone
    // would leave exactly that.
    const fadesAtRest = await page.evaluate(() => {
        const row = document.querySelector(".tb-dock-row");
        row.scrollTo({ left: 0, behavior: "instant" });
        return new Promise((resolve) => setTimeout(() => resolve({
            startChevron: !!document.querySelector(".tb-dock-scroll--start")?.getClientRects().length,
            startFade: !!document.querySelector(".tb-dock-fade--start")?.getClientRects().length,
            endChevron: !!document.querySelector(".tb-dock-scroll--end")?.getClientRects().length,
            endFade: !!document.querySelector(".tb-dock-fade--end")?.getClientRects().length,
        }), 200));
    });
    check("mac: each fade is shown exactly when its own chevron is",
        fadesAtRest.startChevron === fadesAtRest.startFade
            && fadesAtRest.endChevron === fadesAtRest.endFade,
        JSON.stringify(fadesAtRest));
    // A floor on the case above: back at the start, the two edges must DISAGREE
    // with each other, or "they match their chevrons" is being asserted about
    // two pairs that are both simply shown.
    check("mac: and at the start the two edges disagree, so that check discriminates",
        fadesAtRest.startChevron !== fadesAtRest.endChevron,
        JSON.stringify(fadesAtRest));

    // The dropdowns open OUT of a box whose `overflow-x: auto` clips both
    // axes. Escaping that is the whole reason `data-menu-clip` exists, so the
    // check is geometric: the menu has to be taller than the gap it would have
    // been clipped to, and sit above the row rather than below the window.
    await page.evaluate(() => { document.querySelector(".tb-dock-row").scrollLeft = 0; });
    // The caret has to be somewhere a text-hierarchy change applies, or the
    // trigger is inert for the right reason and the hover measures nothing.
    await page.click(".ProseMirror p");
    await page.waitForTimeout(150);
    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(OPEN_WAIT + 120);
    const menuBox = await page.evaluate(() => {
        const menu = document.querySelector('.tb-dock-row [data-item-id="format"] .tb-fmt-menu');
        if (!menu || menu.style.display === "none") { return null; }
        const m = menu.getBoundingClientRect();
        const r = document.querySelector(".tb-dock-row").getBoundingClientRect();
        // Whether the menu is actually THERE, at the pixels it claims. A
        // clipped element still reports its full rect, so geometry alone
        // cannot tell a drawn menu from one the scroller cut away; hit-testing
        // its own centre can.
        const hit = document.elementFromPoint(m.x + m.width / 2, m.y + m.height / 2);
        return {
            position: getComputedStyle(menu).position,
            height: m.height,
            belowRow: m.top >= r.bottom - 1,
            insideViewport: m.top >= 0 && m.bottom <= window.innerHeight,
            rowHeight: r.height,
            reachable: !!hit && menu.contains(hit),
        };
    });
    check("mac: the format dropdown opens at all inside the row", menuBox !== null);
    // Downward, because the row sits at the top of the window now. The old
    // row was at the bottom edge and its menus had to open upward; the
    // direction is the placement engine's answer to where the room is, so it
    // follows the move rather than being configured.
    check("mac: it opens downward, below the row",
        menuBox?.belowRow === true, JSON.stringify(menuBox));
    check("mac: it is positioned in viewport coordinates, so the scroller cannot clip it",
        menuBox?.position === "fixed", JSON.stringify(menuBox));
    check("mac: and it is drawn at full height inside the viewport",
        !!menuBox && menuBox.height > menuBox.rowHeight && menuBox.insideViewport,
        JSON.stringify(menuBox));
    // The one that a rect cannot answer: a clipped menu reports the same
    // rect as a drawn one, so the pixels have to be hit-tested.
    check("mac: and the pixels it claims really are the menu, not the scroller's clip",
        menuBox?.reachable === true, JSON.stringify(menuBox));

    // The pair that stood here drove the pointer from the trigger, through the
    // gap, into the menu, and asserted the menu was still open when it
    // arrived. That was a HOVER property: the menu closed when the pointer
    // left the trigger, and a timer had to hold it across the gap.
    //
    // On this surface the menus open on click (`barMenusOnClick`), so nothing
    // closes when the pointer moves and the crossing has nothing left to
    // exercise. What replaces it is the property that now matters: an open
    // menu stays open while the pointer wanders off it, and the trigger closes
    // it again.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const survivesPointerLeaving = await page.evaluate(() => {
        const menu = document.querySelector('.tb-dock-row [data-item-id="format"] .tb-fmt-menu');
        return !!menu && menu.style.display !== "none";
    });
    check("mac: a click-opened menu stays open when the pointer leaves it",
        survivesPointerLeaving);
    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);
    const closedByTrigger = await page.evaluate(() => {
        const menu = document.querySelector('.tb-dock-row [data-item-id="format"] .tb-fmt-menu');
        return !menu || menu.style.display === "none";
    });
    check("mac: and clicking the trigger again closes it", closedByTrigger);

    // Dismissal, which is the half a click surface has to provide for itself.
    // A hover menu closes when the pointer leaves its wrap, so at most one is
    // ever open and an outside press has nothing to resolve; neither holds
    // here, and both are checked.
    //
    // Driven through real clicks rather than synthesized events, because that
    // is the layer the defect lived in: every trigger swallows its own
    // mousedown, so a listener in the wrong phase hears nothing at all and a
    // prop-level probe would agree with either implementation.
    const menuOpen = (id) => page.evaluate((itemId) => {
        const menu = document.querySelector(
            `.tb-dock-row [data-item-id="${itemId}"] .tb-fmt-menu`);
        return !!menu && menu.style.display !== "none";
    }, id);

    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);
    // THE reported defect: opening a second bar menu left the first on screen,
    // so the format, list and gear menus could all be showing at once.
    await page.locator(`${rowSel} [data-item-id="listMenu"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);
    const secondOpened = await menuOpen("listMenu");
    const firstClosed = !(await menuOpen("format"));
    check("mac: opening a second bar menu closes the first",
        secondOpened && firstClosed,
        JSON.stringify({ secondOpened, firstClosed }));

    // And a press on the page, which belongs to no menu at all.
    //
    // `page.mouse` at a point well below the bar rather than a locator click on
    // a paragraph: the open menu drops down over the top of the document, so
    // Playwright finds the first paragraph covered and retries the click until
    // it times out. What is wanted here is a press at a place no menu is, which
    // is a coordinate rather than an element.
    const belowEverything = await page.evaluate(() => {
        const box = document.querySelector(".milkdown").getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.bottom - 20) };
    });
    await page.mouse.click(belowEverything.x, belowEverything.y);
    await page.waitForTimeout(250);
    const closedByOutside = !(await menuOpen("listMenu"));
    check("mac: and clicking the document closes the open menu", closedByOutside);

    // Reopened, because the checks below act on a row of it.
    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);

    // A row in it still edits the document, which is the point of the dock.
    // Matched on the row's LABEL rather than the row, because the row also
    // carries its chord now (MAR-406) and this surface binds ⌥⌘3, so the row's
    // own text is "H3⌥⌘3". Still dispatched on the row, which is where the
    // handler is, and still anchored, so it cannot start matching H3 inside
    // some longer label later.
    await page.locator('.tb-dock-row [data-item-id="format"] .tb-fmt-item')
        .filter({ has: page.locator(".tb-fmt-fill-label", { hasText: /^Heading 3$/ }) })
        .dispatchEvent("mousedown");
    await page.waitForTimeout(250);
    const becameHeading = await page.evaluate(() =>
        !!document.querySelector(".ProseMirror h3"));
    check("mac: a dock dropdown row still edits the document", becameHeading);

    await page.setViewportSize({ width: viewport?.width ?? 1280, height: viewport?.height ?? 800 });
    await page.waitForTimeout(150);

    // The dock is persistent chrome in a corner transient popups can reach.
    // The top bar never has this problem: `safeAreaTop` keeps every popup out
    // of its band by geometry, and there is no such rule for the bottom edge,
    // so down here the stack is the whole of it. A slash menu the dock paints
    // over is a menu the user cannot read, and stacking is invisible to every
    // check that asks whether an element EXISTS.
    //
    // Asserted as an ORDER rather than by staging a collision, which is a
    // weaker check and worth saying so. `computeAnchoredPosition` flips the
    // slash menu above the caret whenever it does not fit below, so the
    // overlap needs a caret at one particular height for a given menu, and a
    // case that has to be aimed that precisely is one a later change moves out
    // from under without failing. The order holds for every such case at once.
    //
    // What makes the proxy sound is the second assertion: both are
    // `position: fixed` children of <body>, which puts them in one stacking
    // context with nothing between them, so z-index IS paint order here. The
    // day that stops being true this check has to be rewritten, and the
    // assertion is what will say so.
    await mount("index.html");
    await page.locator(".tb-dock-toggle").click();
    await page.waitForTimeout(200);
    const stack = await page.evaluate(() => {
        const dock = document.querySelector(".tb-dock");
        const z = (el) => Number.parseInt(getComputedStyle(el).zIndex, 10);
        // Every transient surface that can open into the bottom leading
        // corner. Created on demand, so each is measured from its own rule
        // rather than from an element that may not exist yet.
        const probe = (className) => {
            const el = document.createElement("div");
            el.className = className;
            document.body.appendChild(el);
            const value = z(el);
            el.remove();
            return value;
        };
        const style = getComputedStyle(dock);
        const box = dock.getBoundingClientRect();
        const bar = document.querySelector(".editor-topbar");
        const barBox = bar.getBoundingClientRect();
        return {
            dock: z(dock),
            dockParentIsBar: dock.parentElement === bar,
            dockPosition: style.position,
            // What every piece of chrome that must stay off the text reads.
            // If this does not include the row, the row is chrome nothing
            // reserved space for.
            reservedHeight: parseFloat(
                getComputedStyle(document.documentElement)
                    .getPropertyValue("--editor-topbar-height")),
            barHeight: barBox.height,
            sitsAtBarBottom: Math.abs(dock.getBoundingClientRect().bottom - barBox.bottom) <= 1,
            // What makes it a docked bar rather than a card: the page's own
            // ground, a hairline on top, square corners, no shadow, and the
            // full width of the window with no inset.
            background: style.backgroundColor,
            barBackground: getComputedStyle(bar).backgroundColor,
            editorBackground: getComputedStyle(document.body).backgroundColor,
            borderTopWidth: style.borderTopWidth,
            borderLeftWidth: style.borderLeftWidth,
            borderRightWidth: style.borderRightWidth,
            borderTopColor: style.borderTopColor,
            // What `currentColor` would resolve to, which is what an
            // unresolved `var()` in a border falls back to.
            ink: style.color,
            borderBottomWidth: style.borderBottomWidth,
            radius: style.borderTopLeftRadius,
            shadow: style.boxShadow,
            left: Math.round(box.left),
            right: Math.round(window.innerWidth - box.right),
            bottom: Math.round(window.innerHeight - box.bottom),
            popups: {
                slashMenu: probe("slash-menu"),
                selectionToolbar: probe("sel-toolbar"),
                notice: probe("ui-notice"),
            },
        };
    });
    // The row is IN the bar, in the bar's flow. That is what replaced the old
    // z-index argument: a strip at the bottom edge had nothing reserving space
    // for it, so it needed a stacking order chosen against every popup that
    // could open into that corner. Nothing paints into the bar's band, because
    // `safeAreaTop()` keeps popups below it by geometry, so a row inside the
    // bar inherits that protection instead of arguing with it.
    // In FLOW is the claim, not any one keyword. `relative` is what the row
    // carries, because the edge chevrons are absolutely positioned against it,
    // and a relatively positioned box still takes up its space in the bar. The
    // two that would break this are `fixed` and `absolute`, which are the two
    // that take the row out of the bar's height and put the old z-index
    // argument back.
    check("mac: the formatting row is in the bar's flow, not a strip of its own",
        stack.dockParentIsBar === true
            && stack.dockPosition !== "fixed" && stack.dockPosition !== "absolute",
        JSON.stringify(stack));
    // A probe that measured nothing reports agreement, so the count of
    // popups that answered with a real z-index is asserted before anything is
    // concluded from them.
    const measured = Object.entries(stack.popups).filter(([, z]) => Number.isFinite(z));
    check("mac: every popup probe actually resolved a z-index",
        measured.length === Object.keys(stack.popups).length, JSON.stringify(stack));
    // The row claims no stacking order of its own. Under the old design this
    // was the check that every popup outranked the strip; the equivalent claim
    // now is that there is no rank to get wrong.
    check("mac: and the row itself claims no z-index, having no one to outrank",
        !Number.isFinite(stack.dock) || stack.dock === 0, JSON.stringify(stack));
    // The load-bearing one: the measured bar height is what the content
    // padding, the find bar, the heading scroll margins and every popup's
    // placement all read, so the row is only really off the text if it is
    // inside that number.
    check("mac: the height every consumer reserves includes the row",
        Math.abs(stack.reservedHeight - stack.barHeight) <= 1, JSON.stringify(stack));
    // Part of the bar rather than a thing on it: the BAR paints the ground and
    // the row adds none of its own, which is the difference between a second
    // row and a panel that happens to sit in the same place. A card would
    // announce itself with a ground, a radius and a shadow; this has none of
    // the three.
    check("mac: the row is part of the bar's ground, not a card on it",
        stack.barBackground === stack.editorBackground
            && stack.background === "rgba(0, 0, 0, 0)"
            && stack.shadow === "none"
            && stack.radius === "0px",
        JSON.stringify(stack));
    // The row draws NO rule, on any side. Between the rows a line reads as two
    // bars where there is one piece of chrome, and below the row it would land
    // against the bar's own hairline with nothing between them and draw as a
    // 2px one. The bar owns that edge; whether it is painted at all is checked
    // in both states at the end of this file. All four sides, because "no
    // border anywhere" is the claim and any one side would break it.
    check("mac: it spans the bar's full width, at its bottom, and draws no rule of its own",
        stack.left === 0 && stack.right === 0 && stack.sitsAtBarBottom
            && stack.borderTopWidth === "0px" && stack.borderBottomWidth === "0px"
            && stack.borderLeftWidth === "0px" && stack.borderRightWidth === "0px",
        JSON.stringify(stack));
    // The check that used to sit here asserted the hairline's COLOUR, because a
    // border whose `var()` resolves to the ground keeps its perfect 1px and
    // draws nothing. It is gone with the hairline itself rather than repointed:
    // with no border drawn, `borderTopColor` computes to `currentColor`, so the
    // old assertion would fail on a row that is exactly right. The rule it was
    // guarding against is still guarded where a border is still drawn.

    // Boot from a saved bag. The write was checked above, and a write nothing
    // reads back is a preference that is not remembered: the shell seeds
    // `getState` in its document-start script (Bridge.userScript), and the
    // dock reads it while it is being built, which is before `init` arrives.
    // Seeded here the same way, so the ORDER is the one the panel has.
    await page.addInitScript(() => { window.__seedState = { formattingRowExpanded: true }; });
    await mount("index.html");
    const booted = await page.evaluate(() => ({
        expanded: document.querySelector(".tb-dock")?.dataset.expanded,
        rowShown: !!document.querySelector(".tb-dock-row")?.getClientRects().length,
        seeded: window.__state?.formattingRowExpanded,
    }));
    check("mac: a saved expanded flag boots the dock open, without a click",
        booted.expanded === "true" && booted.rowShown === true, JSON.stringify(booted));
    check("mac: …and the seed really was in the bag, so that is not a default",
        booted.seeded === true, JSON.stringify(booted));

    // The same message on the control page DOES switch, so the inert check
    // above discriminates.
    await mount("control.html");
    await page.evaluate(() => { window.postMessage({ type: "editorCommand", command: "editRawMarkdown" }, "*"); });
    await page.waitForTimeout(200);
    const ctlSwitched = await page.evaluate(() => window.__posted.filter((m) => m.type === "switchToTextEditor").length);
    check("control: editRawMarkdown via editorCommand posts switchToTextEditor", ctlSwitched === 1, `count=${ctlSwitched}`);

    // ── The bar's hairline, and the row's alignment ────────────────────────
    //
    // Both are DIFFERENCES between the two states, so both are measured in
    // each. A rule that never draws and one that always draws report the same
    // single number if you only look once.
    //
    // Last in the file on purpose: it drives the row to both states and leaves
    // it open, and the sections above assume the state they were handed.
    await mount("index.html");
    const hlState = async () => page.evaluate(() => {
        const bar = document.querySelector(".editor-topbar");
        const dock = document.querySelector(".tb-dock");
        const row = document.querySelector(".tb-dock-row");
        const firstItem = document.querySelector(".tb-dock-row .tb-item");
        const cs = getComputedStyle(bar);
        return {
            expanded: dock?.dataset.expanded,
            borderWidth: cs.borderBottomWidth,
            borderColor: cs.borderBottomColor,
            barBottom: Math.round(bar.getBoundingClientRect().bottom),
            dockBottom: dock && !dock.hidden ? Math.round(dock.getBoundingClientRect().bottom) : null,
            dockOwnBorder: dock ? getComputedStyle(dock).borderBottomWidth : null,
            rowJustify: row ? getComputedStyle(row).justifyContent : null,
            itemLeft: firstItem ? Math.round(firstItem.getBoundingClientRect().left) : null,
            rowLeft: row ? Math.round(row.getBoundingClientRect().left) : null,
        };
    });
    const hlDrive = async (want) => {
        for (let i = 0; i < 3; i++) {
            const isOpen = await page.evaluate(
                () => document.querySelector(".tb-dock")?.dataset.expanded === "true");
            if (isOpen === want) return;
            await page.locator(".tb-dock-toggle").click();
            await page.waitForTimeout(250);
        }
    };
    const isTransparent = (c) => c.includes("rgba(0, 0, 0, 0)") || c.includes("transparent");

    await hlDrive(false);
    const hlShut = await hlState();
    await hlDrive(true);
    const hlOpen = await hlState();

    check("mac: the hairline probe reached both states",
        hlShut.expanded === "false" && hlOpen.expanded === "true",
        JSON.stringify({ shut: hlShut.expanded, open: hlOpen.expanded }));
    check("mac: closed, the bar draws no hairline",
        isTransparent(hlShut.borderColor), JSON.stringify(hlShut));
    check("mac: open, the hairline is drawn",
        !isTransparent(hlOpen.borderColor), JSON.stringify(hlOpen));
    // Colour rather than width, so the measured bar height every consumer
    // reads does not move by a pixel as the row opens.
    check("mac: and the bar's border box is the same in both, so nothing below shifts",
        hlShut.borderWidth === hlOpen.borderWidth,
        JSON.stringify({ shut: hlShut.borderWidth, open: hlOpen.borderWidth }));
    check("mac: the hairline sits below the formatting row, not between the rows",
        hlOpen.dockBottom !== null && hlOpen.barBottom >= hlOpen.dockBottom,
        JSON.stringify({ barBottom: hlOpen.barBottom, dockBottom: hlOpen.dockBottom }));
    check("mac: and the row carries no rule of its own to double it",
        hlOpen.dockOwnBorder === "0px", JSON.stringify({ dockOwnBorder: hlOpen.dockOwnBorder }));

    // A menu opened from the FIRST row paints over the second one.
    //
    // This guards a fix that is NOT here. The row and the bar's first row are
    // siblings and the row comes later in the DOM, which is the shape where a
    // later sibling covers an earlier one's menu, and the borrowed commit
    // raised the first row to stop it. Measured against this tree the menu is
    // already on top: it carries a positive z-index and the row's is auto, and
    // a positive z-index wins inside a stacking context whatever the document
    // order. So the raise was dropped, and this is what says dropping it was
    // safe. Asked of paint order rather than of z-index values, via the point
    // where the two boxes actually overlap.
    await hlDrive(true);
    await page.locator('[data-item-id="settings"]').first().click();
    await page.waitForTimeout(300);
    const zOrder = await page.evaluate(() => {
        const dock = document.querySelector(".tb-dock");
        const menu = [...document.querySelectorAll("[class*='menu']")]
            .filter((el) => el.getClientRects().length && !el.classList.contains("tb-dock"))
            .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
        if (!dock || !menu) return { reached: false, menus: 0 };
        const d = dock.getBoundingClientRect(), m = menu.getBoundingClientRect();
        const overlapY = Math.min(d.bottom, m.bottom) - Math.max(d.top, m.top);
        const overlapX = Math.min(d.right, m.right) - Math.max(d.left, m.left);
        if (overlapY <= 2 || overlapX <= 2) return { reached: false, overlapY, overlapX };
        const x = Math.max(d.left, m.left) + Math.min(overlapX, 20) / 2;
        const y = Math.max(d.top, m.top) + Math.min(overlapY, 20) / 2;
        const hit = document.elementFromPoint(x, y);
        return {
            reached: true, overlapY: Math.round(overlapY),
            menuOnTop: !!(hit && menu.contains(hit)),
            dockOnTop: !!(hit && dock.contains(hit)),
        };
    });
    // Without this arm a menu that never opened, or one that missed the row
    // entirely, would report "the row is not on top" and read as a pass.
    check("mac: the gear's menu really does overlap the formatting row",
        zOrder.reached && zOrder.overlapY > 2, JSON.stringify(zOrder));
    check("mac: and it paints over the row rather than under it",
        zOrder.menuOnTop && !zOrder.dockOnTop, JSON.stringify(zOrder));

    check("mac: the row's controls start at the leading edge rather than centred",
        hlOpen.rowJustify !== "center" && hlOpen.rowJustify !== "safe center"
            && hlOpen.itemLeft !== null && hlOpen.itemLeft - hlOpen.rowLeft <= 4,
        JSON.stringify(hlOpen));


    // The OTHER side of `barMenusOnClick`, on the page that does not declare it.
    //
    // Everything above measures the arrangement being ON. Nothing measured it
    // being off, which is the half the changelog actually promises ("the
    // extension's toolbar menus still open on hover"). Wire `hostArranges` to
    // return true unconditionally and every check above still passes, because
    // none of them ever mounts the control page and points at a trigger.
    //
    // The hover is performed rather than dispatched: `mouseenter` is what the
    // menu listens for, and Playwright's hover fires the real sequence.
    await mount("control.html");
    const ctlHover = await (async () => {
        const trigger = page.locator('.tb-item[data-item-id="format"] .tb-fmt-btn').first();
        const before = await page.evaluate(() =>
            !!document.querySelector('.tb-item[data-item-id="format"] .tb-fmt-menu')?.getClientRects().length);
        await trigger.hover();
        await page.waitForTimeout(OPEN_WAIT);
        const after = await page.evaluate(() =>
            !!document.querySelector('.tb-item[data-item-id="format"] .tb-fmt-menu')?.getClientRects().length);
        return { before, after };
    })();
    check("control: the menu is shut before the pointer arrives", !ctlHover.before,
        JSON.stringify(ctlHover));
    check("control: hovering a bar trigger still opens its menu where the arrangement is absent",
        ctlHover.after, JSON.stringify(ctlHover));

    // Whether a menu trigger NAMES itself, which is the same arrangement asked
    // about a different affordance, and the two answers are opposite.
    //
    // On the control page the menu is what appears under the pointer, so a
    // label appearing first, in the spot the menu is about to take, is noise
    // covered a moment later. Here the pointer opens nothing, so a trigger
    // with no tooltip is a glyph with no way to learn it short of pressing it.
    //
    // Both surfaces are asked, and the control arm is not a formality: a
    // tooltip applied unconditionally passes the mac arm perfectly.
    const tipText = () => page.evaluate(() => {
        const tip = document.querySelector(".custom-tooltip");
        return tip && tip.style.display !== "none" ? tip.textContent : null;
    });
    await page.locator('.tb-item[data-item-id="format"] .tb-fmt-btn').first().hover();
    await page.waitForTimeout(OPEN_WAIT);
    const ctlTip = await tipText();
    check("control: a bar trigger carries no tooltip where hovering opens the menu",
        ctlTip === null, JSON.stringify(ctlTip));

    await mount("index.html");
    const tipMenuSel = '.tb-zone--right [data-item-id="settings"] .tb-settings-menu';
    const tipTrigger = page.locator('.tb-zone--right [data-item-id="settings"] .tb-fmt-btn').first();
    await tipTrigger.hover();
    await page.waitForTimeout(OPEN_WAIT);
    const macTip = await tipText();
    check("mac: resting on a bar trigger names it, because pressing is what opens the menu",
        typeof macTip === "string" && macTip.length > 0, JSON.stringify(macTip));
    // And the label goes when the menu it names arrives, or it sits over the
    // first row the press just revealed. TWO mechanisms hold that, and they
    // are asked separately because either alone passes the other's question:
    // the open path takes down the label already on screen, and the anchor's
    // own `aria-haspopup` and `aria-expanded` stop a fresh hover putting it
    // back. The pointer is already resting on the trigger when the press
    // lands, so the second one is only reachable by leaving and returning.
    await tipTrigger.click();
    await page.waitForTimeout(OPEN_WAIT);
    const openedMenu = await page.evaluate((sel) =>
        !!document.querySelector(sel)?.getClientRects().length, tipMenuSel);
    const tipWhileOpen = await tipText();
    check("mac: the menu really opened, so the tooltip checks below are about an open menu",
        openedMenu);
    check("mac: and the tooltip goes away once the menu it names is out",
        tipWhileOpen === null, JSON.stringify(tipWhileOpen));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(60);
    await tipTrigger.hover();
    await page.waitForTimeout(OPEN_WAIT);
    const stillOpen = await page.evaluate((sel) =>
        !!document.querySelector(sel)?.getClientRects().length, tipMenuSel);
    const tipOnReturn = await tipText();
    check("mac: the menu is still out, so the return-hover check is about an open menu",
        stillOpen);
    check("mac: and resting on the trigger again does not put the label back over the menu",
        tipOnReturn === null, JSON.stringify(tipOnReturn));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(OPEN_WAIT);

    // ── A failed /ai run, on a host that cannot raise a notification ──
    //
    // The Mac shell has no notification surface for the page's own failures, so
    // the editor's corner IS the notification and the reason has to appear
    // there. The VS Code arm is in e2e/agentGutter and e2e/slashMenu, both of
    // which assert the corner stays EMPTY; without this one, a build that
    // never showed the message anywhere would pass all three.
    //
    // Driven by the report alone rather than through the slash menu: the
    // message is what the page reacts to, and a run id it does not recognise
    // reaches the same path, so this needs no editor state at all.
    await mount("index.html");
    const failure = await (async () => {
        await page.evaluate(() => window.postMessage(
            { type: "agentRun", requestId: "no-such-run", status: "failed",
              harness: "claude", message: "command not found" }, "*"));
        await page.waitForTimeout(300);
        const el = await page.evaluate(() => {
            const node = document.querySelector(".agent-toast");
            if (!node) { return null; }
            const box = node.getBoundingClientRect();
            return {
                text: node.textContent,
                opacity: Number(getComputedStyle(node).opacity),
                position: getComputedStyle(node).position,
                fromRight: window.innerWidth - box.right,
                fromBottom: window.innerHeight - box.bottom,
                width: box.width,
                height: box.height,
            };
        });
        return el;
    })();
    check("mac: a failed /ai run says which tool failed and why, in the corner",
        failure !== null && /claude/.test(failure.text) && /command not found/.test(failure.text),
        JSON.stringify(failure));
    check("mac: the message is drawn rather than transparent",
        failure !== null && failure.opacity > 0.9 && failure.width > 0 && failure.height > 0,
        JSON.stringify(failure));
    // Bounded on BOTH sides. Near the corner, and not against it: a host with
    // no notification surface can still draw a status line of its own over the
    // page's bottom edge, and the Mac app does. An upper bound alone would pass a
    // message sitting on top of that line.
    check("mac: it sits near the bottom trailing corner, clear of the window's own edge",
        failure !== null && failure.position === "fixed"
            && failure.fromRight >= 0 && failure.fromRight < 40
            && failure.fromBottom >= 30 && failure.fromBottom < 80,
        JSON.stringify(failure));

    // A click takes it away early. The dwell is long, because the reason is
    // something to read; this is the way out for somebody who has read it.
    await page.evaluate(() => document.querySelector(".agent-toast")
        ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await page.waitForTimeout(300);
    const dismissed = await page.evaluate(() => {
        const el = document.querySelector(".agent-toast");
        return el === null ? null : Number(getComputedStyle(el).opacity);
    });
    check("mac: a click takes the message away", dismissed !== null && dismissed < 0.1,
        String(dismissed));
}
