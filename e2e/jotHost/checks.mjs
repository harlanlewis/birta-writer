/**
 * Host-capability gating end-to-end (MAR-373): the same bundle mounted with
 * the Jot profile has no TOC panel and none of the toolbar items, tray items,
 * gear rows or slash rows that name something its shell does not provide,
 * keeps a chord bound to such a command inert, and still edits. What the shell
 * DOES provide (`imageUpload`) keeps its item and its row, which is the arm
 * that stops a build gating everything from passing.
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
    }));
    check("control: the TOC panel exists when hostCapabilities is absent", ctl.toc);
    check("control: viewSource, styleCheck and image are on the bar when hostCapabilities is absent",
        ["viewSource", "styleCheck", "image"].every((id) => ctl.items.includes(id)),
        JSON.stringify(ctl.items));

    // ── The Jot profile ────────────────────────────────────────────────
    await mount("index.html");
    const jot = await page.evaluate(() => ({
        toc: !!document.querySelector(".toc-panel"),
        tocTab: !!document.querySelector(".toc-toggle-tab"),
        items: [...document.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId),
    }));
    check("jot: no .toc-panel in the DOM", !jot.toc);
    check("jot: no TOC reveal tab either", !jot.tocTab);
    check("jot: no host-bound .tb-item in any zone",
        GATED_ITEMS.every((id) => !jot.items.includes(id)), JSON.stringify(jot.items));
    check("jot: the editor's own items are still on the bar",
        ["format", "bold", "link", "table", "find", "fontPreset", "settings"].every((id) => jot.items.includes(id)),
        JSON.stringify(jot.items));
    // The other direction of the same rule: a capability the host DOES declare
    // keeps its item. Without this the suite would pass a build that gated
    // everything, which is the failure a gating test is most likely to have.
    check("jot: the Image item is present, because the shell declares imageUpload",
        jot.items.includes("image"), JSON.stringify(jot.items));

    // Gear menu: exactly the unconditional rows, in table order, one separator
    // (layout | shortcuts); the settings group is gone with its rows.
    const gearBtn = '[data-item-id="settings"] .tb-fmt-btn';
    const gearMenu = '[data-item-id="settings"] .tb-settings-menu';
    await page.hover(gearBtn);
    await page.waitForTimeout(OPEN_WAIT);
    const gear = await page.$eval(gearMenu, (menu) => ({
        labels: [...menu.querySelectorAll(".tb-fmt-item")].map((el) => el.textContent),
        kinds: [...menu.children].map((el) =>
            el.classList.contains("tb-menu-sep") ? "sep" : el.classList.contains("tb-fmt-item") ? "item" : el.className),
    }));
    // The shell has a Settings window (`appPreferences`), so its row belongs;
    // VS Code's own settings and keybindings rows do not, and neither does the
    // release page. This asserts both directions in one list.
    check("jot: gear menu offers the layout rows, the cheatsheet, and the shell's own Settings",
        JSON.stringify(gear.labels) === JSON.stringify(
            ["Customize Toolbar", "Hide Toolbar", "Show Keyboard Shortcuts", "Birta Jot Settings"]),
        JSON.stringify(gear.labels));
    check("jot: gear menu separates the groups without dangling one",
        JSON.stringify(gear.kinds) === JSON.stringify(["item", "item", "sep", "item", "sep", "item"]),
        JSON.stringify(gear.kinds));

    // Customize mode via the gear row: the hidden tray offers no gated item.
    await page.locator(`${gearMenu} .tb-fmt-item`, { hasText: "Customize Toolbar" }).dispatchEvent("mousedown");
    await page.waitForTimeout(200);
    const tray = await page.evaluate(() => {
        const t = document.querySelector(".tb-hidden-tray-items");
        return t ? [...t.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId) : null;
    });
    check("jot: customize mode opened its hidden tray", Array.isArray(tray), JSON.stringify(tray));
    check("jot: the hidden tray offers no host-bound item",
        Array.isArray(tray) && GATED_ITEMS.every((id) => !tray.includes(id)), JSON.stringify(tray));
    check("jot: the hidden tray still offers the editor's own hidden items (footnote, math)",
        Array.isArray(tray) && ["footnote", "math"].every((id) => tray.includes(id)), JSON.stringify(tray));
    const allItems = await itemIds();
    check("jot: no host-bound item anywhere in the DOM while customizing",
        GATED_ITEMS.every((id) => !allItems.includes(id)), JSON.stringify(allItems));
    await page.locator(".tb-edit-done").click();
    await page.waitForTimeout(200);

    // Shortcuts help: the cheatsheet opens, without the Edit Keyboard
    // Shortcuts footer (a keybindings UI the host does not have).
    await page.hover(gearBtn);
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

    // The same message on the control page DOES switch, so the inert check
    // above discriminates.
    await mount("control.html");
    await page.evaluate(() => { window.postMessage({ type: "editorCommand", command: "editRawMarkdown" }, "*"); });
    await page.waitForTimeout(200);
    const ctlSwitched = await page.evaluate(() => window.__posted.filter((m) => m.type === "switchToTextEditor").length);
    check("control: editRawMarkdown via editorCommand posts switchToTextEditor", ctlSwitched === 1, `count=${ctlSwitched}`);
}
