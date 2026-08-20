/**
 * The host profile end-to-end (MAR-373): the same bundle mounted with the Jot
 * profile has no TOC panel and none of the toolbar items, gear rows or slash
 * rows that name something its shell does not provide, keeps a chord bound to
 * such a command inert, and still edits. What the shell DOES provide
 * (`imageUpload`) keeps its item and its row, which is the arm that stops a
 * build gating everything from passing.
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
    // Jot declares `imageUpload`, so the Image item is NOT gated here: it is
    // in the list below, as one of the editor's own items that must survive.
    const GATED_ITEMS = ["viewSource", "styleCheck", "readOnly"];
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
    }));
    check("control: the TOC panel exists when hostCapabilities is absent", ctl.toc);
    check("control: no formatting dock, because the arrangement is not declared", !ctl.dock);
    check("control: the editing controls are in the top bar's left zone",
        ctl.leftZone.includes("bold") && ctl.leftZone.includes("format"),
        JSON.stringify(ctl.leftZone));
    check("control: viewSource, styleCheck and image are on the bar when hostCapabilities is absent",
        ["viewSource", "styleCheck", "image"].every((id) => ctl.items.includes(id)),
        JSON.stringify(ctl.items));

    // ── The Jot profile ────────────────────────────────────────────────
    await mount("index.html");
    const jot = await page.evaluate(() => ({
        toc: !!document.querySelector(".toc-panel"),
        tocTab: !!document.querySelector(".toc-toggle-tab"),
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
    check("jot: no .toc-panel in the DOM", !jot.toc);
    check("jot: no TOC reveal tab either", !jot.tocTab);
    check("jot: no host-bound .tb-item in any zone",
        GATED_ITEMS.every((id) => !jot.items.includes(id)), JSON.stringify(jot.items));
    check("jot: the editor's own items are all still built",
        ["format", "bold", "link", "table", "find", "settings"].every((id) => jot.items.includes(id)),
        JSON.stringify(jot.items));

    // ── formattingInSecondRow ─────────────────────────────────────────
    // The partition itself is unit-tested (toolbarRegistry.test.ts); what only
    // a real page can answer is whether the two holders actually received it.
    check("jot: the top bar's left zone is empty, leaving the titlebar row to the window",
        jot.leftZone.length === 0, JSON.stringify(jot.leftZone));
    check("jot: the top bar keeps only the controls that read the document",
        JSON.stringify(jot.rightZone) === JSON.stringify(["find", "settings"]),
        JSON.stringify(jot.rightZone));
    check("jot: every editing control is in the dock instead",
        ["format", "bold", "italic", "link", "listMenu", "quote", "codeBlock", "table", "image"]
            .every((id) => jot.dock.includes(id)),
        JSON.stringify(jot.dock));
    // The dock takes no placement config, so the controls that ship hidden on
    // the top bar are here too. This is the half that separates "moved the
    // bar" from "all the formatting controls".
    check("jot: the dock also carries the controls that ship hidden on the bar",
        ["strikethrough", "highlight", "inlineCode", "horizontalRule", "math", "footnote", "clearFormatting"]
            .every((id) => jot.dock.includes(id)),
        JSON.stringify(jot.dock));
    check("jot: no item is on both surfaces",
        jot.dock.every((id) => !jot.rightZone.includes(id)),
        JSON.stringify({ dock: jot.dock, right: jot.rightZone }));

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
        const find = document.querySelector('[data-item-id="find"]');
        return {
            rowInBar: row?.parentElement === bar,
            toggleInBar: !!toggle?.closest(".editor-topbar") && !toggle?.closest(".tb-dock"),
            togglePrecedesFind: toggle?.nextElementSibling === find,
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
    check("jot: the formatting row is a row of the top bar, not a strip of its own",
        rowGeometry.rowInBar, JSON.stringify(rowGeometry));
    check("jot: its toggle is in the bar itself, not in the row it opens",
        rowGeometry.toggleInBar, JSON.stringify(rowGeometry));
    check("jot: the toggle sits immediately before Find",
        rowGeometry.togglePrecedesFind, JSON.stringify(rowGeometry));
    check("jot: opening the row makes the bar taller, so everything that measures it follows",
        rowGeometry.expanded > rowGeometry.collapsed, JSON.stringify(rowGeometry));

    // ── fixedToolbarLayout ─────────────────────────────────────────────
    check("jot: no reveal tab, because the bar never hides", !jot.showTab);
    // The typography rows live in the gear here, so the item that would open a
    // second dropdown beside it is not built. Asserted with the gear rows
    // below, which is the other half: absent from the bar AND present in the
    // menu, or this passes on a build that simply lost the controls.
    check("jot: no separate font item, because its rows are in the gear",
        !jot.items.includes("fontPreset"), JSON.stringify(jot.items));
    // The other direction of the same rule: a capability the host DOES declare
    // keeps its item. Without this the suite would pass a build that gated
    // everything, which is the failure a gating test is most likely to have.
    check("jot: the Image item is present, because the shell declares imageUpload",
        jot.items.includes("image"), JSON.stringify(jot.items));

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
    check("jot: gear menu offers the typography presets, the cheatsheet and the shell's own Settings",
        JSON.stringify(gear.labels) === JSON.stringify(
            ["Sans serif", "Serif", "Monospace",
             "Show Keyboard Shortcuts", "Birta Jot Settings"]),
        JSON.stringify(gear.labels));
    // The typography rows stay at the TOP with the layout rows withdrawn. They
    // are what a reader opens this menu for, and the rule that placed them
    // ("after the layout rows") has to survive there being none.
    check("jot: the typography rows are still first, not pushed below the cheatsheet",
        gear.labels.indexOf("Serif") < gear.labels.indexOf("Show Keyboard Shortcuts"),
        JSON.stringify(gear.labels));
    check("jot: and neither layout row, because the arrangement is not the user's",
        !gear.labels.includes("Customize Toolbar") && !gear.labels.includes("Hide Toolbar"),
        JSON.stringify(gear.labels));
    // Editor font needs an editor font to inherit and the width segments need
    // a pane wide enough for a measure to be a choice; the shell declares
    // neither, so neither row is here even though both would be in VS Code.
    check("jot: the gear offers no Editor-font row and no width segments",
        !gear.labels.includes("Editor font") && !gear.hasWidthRow,
        JSON.stringify({ labels: gear.labels, hasWidthRow: gear.hasWidthRow }));
    check("jot: the size stepper came with them", gear.hasSizeRow, JSON.stringify(gear.kinds));

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
    check("jot: a font command still applies with the rows in the gear",
        fontAfter !== fontBefore && /mono/i.test(fontAfter), JSON.stringify({ fontBefore, fontAfter }));

    // …and the checkmark in the gear followed it, so the menu and the document
    // never disagree about which preset is on.
    await page.locator(gearBtn).click();
    await page.waitForTimeout(OPEN_WAIT);
    const checked = await page.$eval(gearMenu, (menu) =>
        [...menu.querySelectorAll(".tb-fmt-item")]
            .filter((el) => el.getAttribute("aria-checked") === "true")
            .map((el) => el.textContent));
    check("jot: …and the gear's checkmark moved with it",
        JSON.stringify(checked) === JSON.stringify(["Monospace"]), JSON.stringify(checked));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    // Asserted as what it means rather than through "starts with an item":
    // with the layout rows withdrawn the menu opens on the size stepper, which
    // is a row and not a separator, and the proxy would have called that a
    // dangling one.
    check("jot: gear menu separates the groups without dangling one",
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
    check("jot: the customizeToolbar command opens no tray",
        !afterWithdrawn.tray, JSON.stringify(afterWithdrawn));
    check("jot: the hideToolbar command leaves the bar alone",
        !afterWithdrawn.barHidden, JSON.stringify(afterWithdrawn));
    check("jot: and the dock is still there afterwards",
        afterWithdrawn.dock, JSON.stringify(afterWithdrawn));

    const allItems = await itemIds();
    check("jot: no host-bound item anywhere in the DOM",
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
    check("jot: the shortcuts cheatsheet still opens", help.open, JSON.stringify(help));
    check("jot: the cheatsheet has no Edit Keyboard Shortcuts footer", !help.footer, JSON.stringify(help));

    // The host's own shortcuts print in the cheatsheet, rendered by the same
    // helper as every other row rather than as a raw string in the same
    // column. The harness declares two, which is enough to prove both the
    // section and the rendering; the real shell declares its whole menu.
    const hostRows = await page.evaluate(() => {
        const heads = [...document.querySelectorAll(".shortcuts-help__section-title")];
        const section = heads.find((h) => h.textContent === "This app");
        if (!section) { return null; }
        const rows = [];
        for (let el = section.nextElementSibling;
             el && !el.classList.contains("shortcuts-help__section-title");
             el = el.nextElementSibling) {
            const chip = el.querySelector("kbd");
            if (chip) { rows.push(chip.textContent); }
        }
        return rows;
    });
    check("jot: the cheatsheet prints a section for the host's own shortcuts",
        Array.isArray(hostRows) && hostRows.length > 0, JSON.stringify(hostRows));
    check("jot: …rendered as glyphs by the shared helper, not the raw notation",
        Array.isArray(hostRows) && hostRows.some((k) => /⌘/.test(k)) && !hostRows.some((k) => /Mod-/.test(k)),
        JSON.stringify(hostRows));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Typing works.
    await page.locator(".milkdown .ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type(" jotted", { delay: 30 });
    await page.waitForTimeout(600);
    const typed = await page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update").map((m) => m.content);
        return updates[updates.length - 1] ?? "";
    });
    check("jot: typing reaches the document (an update carries the text)", /Some text\. jotted/.test(typed),
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
    // Rows bound to a capability Jot's shell does NOT provide. "Ask Agent" is
    // deliberately absent from this list: the shell runs one now, so its row
    // belongs, and moving it to the offered set below is the point.
    const GATED_LABELS = ["Edit Raw Markdown", "Settings", "Edit Keyboard Shortcuts", "Check spelling",
        "Check grammar", "Check style", "Highlight note markers", "Lock Edits (Read-only)",
        "Editor Font", "Full Width", "Fixed Width"];
    check("jot: Show all commands lists no row bound to a capability the shell lacks",
        GATED_LABELS.every((l) => !labels.includes(l)), JSON.stringify(labels.filter((l) => GATED_LABELS.includes(l))));
    check("jot: Show all commands still lists the editor's own rows",
        ["Table", "Code Block", "Bold", "Find"].every((l) => labels.includes(l)), JSON.stringify(labels));
    // The other half of the gate: a capability the shell DOES declare has to
    // put its row back, or the check above would pass on a page that offers
    // nothing at all.
    check("jot: Show all commands lists the rows the shell's own capabilities earn",
        ["Image", "Ask Agent"].every((l) => labels.includes(l)), JSON.stringify(labels));
    check("jot: no TOC rows in the slash menu", !labels.some((l) => /Table of Contents/.test(l)),
        JSON.stringify(labels.filter((l) => /Table of Contents/.test(l))));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    for (const [q, label] of [["raw", "Edit Raw Markdown"], ["setting", "Settings"], ["spell", "Check spelling"]]) {
        await openSlash(q, { expectRows: false });
        labels = await page.evaluate((sel) => {
            const menu = document.querySelector(sel);
            if (!menu || getComputedStyle(menu).display === "none") { return []; }
            return [...menu.querySelectorAll(".slash-menu-item-label")].map((e) => e.textContent);
        }, SLASH);
        check(`jot: searching "/${q}" does not surface "${label}"`, !labels.includes(label), JSON.stringify(labels));
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
    check("jot: editRawMarkdown via editorCommand posts no switchToTextEditor", after.switched === before,
        `before=${before} after=${after.switched}`);
    check("jot: toggleReadOnly via editorCommand leaves the editor editable", !after.readOnly);

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
            saved: window.__state?.formattingDockExpanded,
            barHeight: bar?.getBoundingClientRect().height ?? null,
        };
    });

    const collapsed = await dockState();
    check("jot: the row starts collapsed, with only the T in the bar",
        collapsed.expanded === "false" && collapsed.toggleShown && !collapsed.rowShown
            && collapsed.glyph === "T",
        JSON.stringify(collapsed));

    await page.locator(toggleSel).click();
    await page.waitForTimeout(200);
    const expanded = await dockState();
    check("jot: clicking the T opens the row",
        expanded.expanded === "true" && expanded.rowShown,
        JSON.stringify(expanded));
    // And the bar is what grew. Collapsed the row must not merely be invisible
    // but absent from the bar's box, or the content below stays pushed down
    // around a row nobody can see.
    check("jot: opening it grows the bar, closing it gives the height back",
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
    check("jot: the row it could push is really there to be pushed",
        hoverShift.away.firstItemLeft !== null, JSON.stringify(hoverShift));
    check("jot: hovering the toggle moves nothing in the row",
        hoverShift.over.toggle === hoverShift.away.toggle
            && hoverShift.over.firstItemLeft === hoverShift.away.firstItemLeft,
        JSON.stringify(hoverShift));
    check("jot: and the toggle carries no chevron beside the letter",
        (await page.evaluate(() => !document.querySelector(".tb-dock-chevron"))),
        "a chevron is present");
    check("jot: and the choice was written to the view-state bag",
        expanded.saved === true, JSON.stringify(expanded));

    // Narrow enough that the row cannot fit: it must SCROLL rather than wrap,
    // clip silently, or push the window wider than the viewport.
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 420, height: viewport?.height ?? 800 });
    await page.waitForTimeout(250);
    const narrow = await dockState();
    const bodyOverflow = await page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1);
    check("jot: a window too narrow for the row makes the row scroll",
        narrow.overflows === true, JSON.stringify(narrow));
    check("jot: and never the page itself", bodyOverflow);
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
    check("jot: at the start of an overflowing row, only the forward chevron shows",
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
    check("jot: clicking it scrolls the row",
        chevronsScrolled.scrollLeft > chevronsNarrow.scrollLeft,
        JSON.stringify({ before: chevronsNarrow.scrollLeft, after: chevronsScrolled.scrollLeft }));
    check("jot: and the back chevron appears once there is something behind you",
        chevronsScrolled.startShown, JSON.stringify(chevronsScrolled));

    check("jot: the last control can be reached by scrolling", scrolled);

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
    check("jot: the format dropdown opens at all inside the row", menuBox !== null);
    // Downward, because the row sits at the top of the window now. The old
    // row was at the bottom edge and its menus had to open upward; the
    // direction is the placement engine's answer to where the room is, so it
    // follows the move rather than being configured.
    check("jot: it opens downward, below the row",
        menuBox?.belowRow === true, JSON.stringify(menuBox));
    check("jot: it is positioned in viewport coordinates, so the scroller cannot clip it",
        menuBox?.position === "fixed", JSON.stringify(menuBox));
    check("jot: and it is drawn at full height inside the viewport",
        !!menuBox && menuBox.height > menuBox.rowHeight && menuBox.insideViewport,
        JSON.stringify(menuBox));
    // The one that a rect cannot answer: a clipped menu reports the same
    // rect as a drawn one, so the pixels have to be hit-tested.
    check("jot: and the pixels it claims really are the menu, not the scroller's clip",
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
    check("jot: a click-opened menu stays open when the pointer leaves it",
        survivesPointerLeaving);
    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);
    const closedByTrigger = await page.evaluate(() => {
        const menu = document.querySelector('.tb-dock-row [data-item-id="format"] .tb-fmt-menu');
        return !menu || menu.style.display === "none";
    });
    check("jot: and clicking the trigger again closes it", closedByTrigger);
    // Reopened, because the checks below act on a row of it.
    await page.locator(`${rowSel} [data-item-id="format"] .tb-fmt-btn`).click();
    await page.waitForTimeout(250);

    // A row in it still edits the document, which is the point of the dock.
    await page.locator('.tb-dock-row [data-item-id="format"] .tb-fmt-item', { hasText: /^H3$/ })
        .dispatchEvent("mousedown");
    await page.waitForTimeout(250);
    const becameHeading = await page.evaluate(() =>
        !!document.querySelector(".ProseMirror h3"));
    check("jot: a dock dropdown row still edits the document", becameHeading);

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
    check("jot: the formatting row is in the bar's flow, not a strip of its own",
        stack.dockParentIsBar === true
            && stack.dockPosition !== "fixed" && stack.dockPosition !== "absolute",
        JSON.stringify(stack));
    // A probe that measured nothing reports agreement, so the count of
    // popups that answered with a real z-index is asserted before anything is
    // concluded from them.
    const measured = Object.entries(stack.popups).filter(([, z]) => Number.isFinite(z));
    check("jot: every popup probe actually resolved a z-index",
        measured.length === Object.keys(stack.popups).length, JSON.stringify(stack));
    // The row claims no stacking order of its own. Under the old design this
    // was the check that every popup outranked the strip; the equivalent claim
    // now is that there is no rank to get wrong.
    check("jot: and the row itself claims no z-index, having no one to outrank",
        !Number.isFinite(stack.dock) || stack.dock === 0, JSON.stringify(stack));
    // The load-bearing one: the measured bar height is what the content
    // padding, the find bar, the heading scroll margins and every popup's
    // placement all read, so the row is only really off the text if it is
    // inside that number.
    check("jot: the height every consumer reserves includes the row",
        Math.abs(stack.reservedHeight - stack.barHeight) <= 1, JSON.stringify(stack));
    // Part of the bar rather than a thing on it: the BAR paints the ground and
    // the row adds none of its own, which is the difference between a second
    // row and a panel that happens to sit in the same place. A card would
    // announce itself with a ground, a radius and a shadow; this has none of
    // the three.
    check("jot: the row is part of the bar's ground, not a card on it",
        stack.barBackground === stack.editorBackground
            && stack.background === "rgba(0, 0, 0, 0)"
            && stack.shadow === "none"
            && stack.radius === "0px",
        JSON.stringify(stack));
    // No rule BETWEEN the rows, and one UNDER the bar. The two rows are one
    // piece of chrome, so a line drawn across the window between them reads as
    // two bars; the hairline belongs where chrome meets text. Asserted on all
    // four sides, because "a bottom border and nothing else" is the claim and
    // any other side would break it.
    check("jot: it spans the bar's full width, at its bottom, with a hairline under it only",
        stack.left === 0 && stack.right === 0 && stack.sitsAtBarBottom
            && stack.borderTopWidth === "0px" && stack.borderBottomWidth === "1px"
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
    await page.addInitScript(() => { window.__seedState = { formattingDockExpanded: true }; });
    await mount("index.html");
    const booted = await page.evaluate(() => ({
        expanded: document.querySelector(".tb-dock")?.dataset.expanded,
        rowShown: !!document.querySelector(".tb-dock-row")?.getClientRects().length,
        seeded: window.__state?.formattingDockExpanded,
    }));
    check("jot: a saved expanded flag boots the dock open, without a click",
        booted.expanded === "true" && booted.rowShown === true, JSON.stringify(booted));
    check("jot: …and the seed really was in the bag, so that is not a default",
        booted.seeded === true, JSON.stringify(booted));

    // The same message on the control page DOES switch, so the inert check
    // above discriminates.
    await mount("control.html");
    await page.evaluate(() => { window.postMessage({ type: "editorCommand", command: "editRawMarkdown" }, "*"); });
    await page.waitForTimeout(200);
    const ctlSwitched = await page.evaluate(() => window.__posted.filter((m) => m.type === "switchToTextEditor").length);
    check("control: editRawMarkdown via editorCommand posts switchToTextEditor", ctlSwitched === 1, `count=${ctlSwitched}`);
}
