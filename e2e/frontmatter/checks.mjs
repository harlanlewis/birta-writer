/**
 * Frontmatter (metadata) panel end-to-end checks against the real bundle:
 * unified bottom buttons, first-column trash-can delete, keyboard activation,
 * panel-local Cmd+Z undo/redo, and panel survival when the last field is
 * deleted. Outbound edits land in window.__posted as `frontmatterUpdate`.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector("#frontmatter-panel .frontmatter-table", { timeout: 10000 });
    await page.waitForTimeout(300);

    const fmUpdates = () =>
        page.evaluate(() =>
            window.__posted.filter((m) => m.type === "frontmatterUpdate").map((m) => m.frontmatter),
        );
    const lastFm = async () => {
        const u = await fmUpdates();
        return u[u.length - 1] ?? null;
    };

    // ── 0. Borderless table: no outer frame, rounded corners, or row dividers ──
    const tableBorder = await page.locator(".frontmatter-table").evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
            topWidth: cs.borderTopWidth,
            radius: cs.borderTopLeftRadius,
            // A row's cell must carry no bottom divider either.
            cellBottom: getComputedStyle(el.querySelector("td")).borderBottomWidth,
        };
    });
    check("frontmatter table has no outer border", tableBorder.topWidth === "0px", tableBorder.topWidth);
    check("frontmatter table has no rounded corners", tableBorder.radius === "0px", tableBorder.radius);
    check("frontmatter table rows have no divider", tableBorder.cellBottom === "0px", tableBorder.cellBottom);

    // ── 1. Structure: trash button is the FIRST cell, left of the key ──
    const firstRow = page.locator("#frontmatter-panel tbody tr").nth(0);
    const firstCellClass = await firstRow.locator("td").nth(0).getAttribute("class");
    check("first cell in a row is the action (delete) cell", (firstCellClass ?? "").includes("fm-action"), firstCellClass);
    const secondCellClass = await firstRow.locator("td").nth(1).getAttribute("class");
    check("second cell is the key", (secondCellClass ?? "").includes("fm-key"), secondCellClass);

    const trash = firstRow.locator(".fm-delete-btn");
    check("delete button carries an svg (trash icon)", (await trash.locator("svg").count()) === 1);
    const trashAria = await trash.getAttribute("aria-label");
    check(
        "delete button aria-label names the field",
        (trashAria ?? "").includes("title"),
        JSON.stringify(trashAria),
    );

    // ── 2. Unified bottom buttons: toggle and add-field look the same ──
    const styleOf = (sel, prop) =>
        page.locator(sel).evaluate((el, p) => getComputedStyle(el)[p], prop);
    const toggleBorder = await styleOf(".fm-toggle-btn", "borderStyle");
    const addBorder = await styleOf(".fm-add-btn", "borderStyle");
    check(
        "toggle and add-field share one border style (no dashed/solid split)",
        toggleBorder === addBorder,
        `toggle=${toggleBorder} add=${addBorder}`,
    );
    const chipAddBorder = await styleOf(".fm-chip-add", "borderStyle");
    check("chip add button is not dashed either", chipAddBorder !== "dashed", chipAddBorder);

    // ── 3. Keyboard activation: detail-0 click collapses the panel ──
    const panelCollapsed = () =>
        page.locator("#frontmatter-panel").evaluate((el) => el.classList.contains("collapsed"));
    check("panel starts expanded", !(await panelCollapsed()));
    const ariaExpandedBefore = await page.locator(".fm-toggle-btn").getAttribute("aria-expanded");
    check("toggle exposes aria-expanded=true when open", ariaExpandedBefore === "true", ariaExpandedBefore);
    await page.locator(".fm-toggle-btn").evaluate((el) => el.click()); // detail 0 → keyboard path
    await page.waitForTimeout(150);
    check("keyboard (detail-0) click collapses the panel", await panelCollapsed());
    check(
        "toggle aria-expanded flips to false when collapsed",
        (await page.locator(".fm-toggle-btn").getAttribute("aria-expanded")) === "false",
    );
    await page.locator(".fm-toggle-btn").evaluate((el) => el.click());
    await page.waitForTimeout(150);
    check("keyboard click expands it again", !(await panelCollapsed()));

    // ── 4. Editing a value commits via Enter, posts frontmatterUpdate ──
    const titleVal = page.locator("#frontmatter-panel tbody tr").nth(0).locator(".fm-val");
    await titleVal.click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.type("Edited inventory");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    let fm = await lastFm();
    check(
        "editing a value + Enter posts the new frontmatter",
        fm !== null && fm.includes("title: Edited inventory"),
        JSON.stringify(fm),
    );
    check(
        "Enter keeps focus in the value cell (undo stays reachable)",
        await titleVal.evaluate((el) => el === document.activeElement),
    );

    // ── 5. Cmd+Z undoes the committed value edit ──
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    fm = await lastFm();
    check(
        "Cmd+Z posts the pre-edit frontmatter",
        fm !== null && fm.includes("title: Content inventory"),
        JSON.stringify(fm),
    );
    // Redo
    await page.keyboard.press("Meta+Shift+z");
    await page.waitForTimeout(200);
    fm = await lastFm();
    check(
        "Cmd+Shift+Z redoes the value edit",
        fm !== null && fm.includes("title: Edited inventory"),
        JSON.stringify(fm),
    );

    // ── 6. Trash delete removes the field and survives to empty ──
    const rowCountBefore = await page.locator("#frontmatter-panel tbody tr").count();
    await page.locator("#frontmatter-panel tbody tr").nth(0).locator(".fm-delete-btn").evaluate((el) => el.click());
    await page.waitForTimeout(200);
    const rowCountAfter = await page.locator("#frontmatter-panel tbody tr").count();
    check("deleting a field removes its row", rowCountAfter === rowCountBefore - 1, `${rowCountBefore} → ${rowCountAfter}`);
    fm = await lastFm();
    check("delete posts frontmatter without the deleted key", fm !== null && !fm.includes("title:"), JSON.stringify(fm));

    // Delete the remaining field(s) → panel must survive with an empty table
    let guard = 0;
    while ((await page.locator("#frontmatter-panel tbody tr").count()) > 0 && guard++ < 6) {
        await page.locator("#frontmatter-panel tbody tr").nth(0).locator(".fm-delete-btn").evaluate((el) => el.click());
        await page.waitForTimeout(150);
    }
    check("panel survives after the last field is deleted", (await page.locator("#frontmatter-panel").count()) === 1);
    fm = await lastFm();
    check("emptying all fields posts an empty frontmatter string", fm === "", JSON.stringify(fm));

    // ── 7. Undo after the deletes restores fields (panel stayed alive) ──
    // Focus directly: a center-of-panel click can land under the fixed toolbar
    // now that the harness bar has a realistic height.
    await page.locator("#frontmatter-panel").evaluate((el) => el.focus());
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(200);
    const rowsAfterUndo = await page.locator("#frontmatter-panel tbody tr").count();
    check("Cmd+Z after deleting restores a field row", rowsAfterUndo >= 1, `${rowsAfterUndo} rows`);
    fm = await lastFm();
    check("undo re-posts frontmatter content", fm !== null && fm.length > 0, JSON.stringify(fm));

    // ── 8. Add field: creates a focused empty row; abandoning it cleans up ──
    const rowsBeforeAdd = await page.locator("#frontmatter-panel tbody tr").count();
    await page.locator(".fm-add-btn").evaluate((el) => el.click());
    await page.waitForTimeout(150);
    check(
        "Add field creates a new row",
        (await page.locator("#frontmatter-panel tbody tr").count()) === rowsBeforeAdd + 1,
    );
    // Abandon it (focus away) → ghost row removed
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(200);
    check(
        "an abandoned empty new row is cleaned up on focusout",
        (await page.locator("#frontmatter-panel tbody tr").count()) === rowsBeforeAdd,
    );

    // ── 9. Tab / Shift+Tab navigation (regression: Shift+Tab added a row) ──
    // Real-browser keyboard Tab differs from jsdom, so exercise it here. Add a
    // scalar field, name its key, Tab into the value, then Shift+Tab back.
    await page.locator(".fm-add-btn").evaluate((el) => el.click());
    await page.waitForTimeout(120);
    await page.locator("#frontmatter-panel tbody tr").last().locator(".fm-key").click();
    await page.keyboard.type("author");
    await page.keyboard.press("Tab"); // key → value (same row)
    check(
        "Tab from a key cell lands on the value cell",
        await page.evaluate(() => document.activeElement?.classList.contains("fm-val")),
    );
    const rowsAtTab = await page.locator("#frontmatter-panel tbody tr").count();
    await page.keyboard.press("Shift+Tab"); // value → key; must NOT add a row
    await page.waitForTimeout(120);
    check(
        "Shift+Tab from a value cell does not create a new row",
        (await page.locator("#frontmatter-panel tbody tr").count()) === rowsAtTab,
        `${rowsAtTab} → ${await page.locator("#frontmatter-panel tbody tr").count()}`,
    );
    check(
        "Shift+Tab from a value cell returns focus to its key cell",
        await page.evaluate(() => document.activeElement?.classList.contains("fm-key")),
    );

    // ── 10. Empty state: "Add metadata" sits below the toolbar, clear of content ──
    // Regression guards, both found the hard way: a hardcoded top offset put the
    // button underneath the fixed .editor-topbar, and an out-of-flow rework put
    // it underneath the first content line instead (visible but not clickable —
    // #editor's blocks intercepted the pointer). It must clear the measured
    // toolbar, stay clear of the first content block, and take a REAL click.
    await page.goto(`${baseUrl}/index.html?empty=1`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector("#frontmatter-panel.fm-empty .fm-add-metadata-btn", { timeout: 10000 });
    await page.waitForTimeout(200);
    const btnBox = await page.locator(".fm-add-metadata-btn").boundingBox();
    const barBottom = await page
        .locator(".editor-topbar")
        .evaluate((el) => el.getBoundingClientRect().bottom);
    check(
        "empty-state Add metadata button sits below the toolbar",
        btnBox !== null && btnBox.y >= barBottom,
        `button.y=${btnBox?.y} toolbar.bottom=${barBottom}`,
    );
    const firstBlockTop = await page
        .locator(".milkdown .ProseMirror > *")
        .first()
        .evaluate((el) => el.getBoundingClientRect().top);
    check(
        "empty-state button stays clear of the first content block",
        btnBox !== null && btnBox.y + btnBox.height <= firstBlockTop,
        `button.bottom=${btnBox ? btnBox.y + btnBox.height : "?"} content.top=${firstBlockTop}`,
    );
    // A real pointer click (Playwright verifies the hit target) must reach it.
    await page.locator(".fm-add-metadata-btn").click();
    await page.waitForTimeout(150);
    check(
        "a real click on Add metadata opens the metadata table",
        (await page.locator("#frontmatter-panel .frontmatter-table").count()) === 1,
    );

    // ── 11. The shipped default (birta.frontmatterAddButton off) reclaims the row ──
    // The point of the default is geometry, not just a hidden button: the
    // document must start where it would with no panel feature at all. jsdom
    // can assert the panel is absent but not that the inset actually went with
    // it, so the measurement belongs here.
    await page.goto(`${baseUrl}/index.html?empty=1&addBtn=0`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);
    check(
        "gate off renders no frontmatter panel on a metadata-less document",
        (await page.locator("#frontmatter-panel").count()) === 0,
    );
    const gatedTop = await page
        .locator(".milkdown .ProseMirror > *")
        .first()
        .evaluate((el) => el.getBoundingClientRect().top);
    const gatedBarBottom = await page
        .locator(".editor-topbar")
        .evaluate((el) => el.getBoundingClientRect().bottom);
    // Measured against the SAME gap with the gate on, rather than a magic
    // ceiling: the whole row the button occupied must be reclaimed, so the
    // toolbar→content gap has to shrink by at least the button's own height.
    // A hardcoded threshold could pass without discriminating if the two
    // layouts ever converged; this cannot.
    const onGap = firstBlockTop - barBottom;
    const offGap = gatedTop - gatedBarBottom;
    check(
        "gate off reclaims the whole button row above the first block",
        btnBox !== null && offGap <= onGap - btnBox.height,
        `offGap=${offGap} onGap=${onGap} buttonHeight=${btnBox?.height}`,
    );

    // ── 12. TOML (+++) front matter reaches the panel, and edits round-trip ──
    // The panel is the whole point: before MAR-363 a `+++` block was not front
    // matter at all, so its fences and keys were document body. jsdom can
    // assert the routing; only the real bundle shows the block actually leaving
    // the editor content.
    await page.goto(`${baseUrl}/index.html?toml=1`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector("#frontmatter-panel .fm-raw-editor", { timeout: 10000 });
    await page.waitForTimeout(200);

    const tomlRaw = page.locator("#frontmatter-panel .fm-raw-editor");
    check(
        "a TOML block loads into the metadata panel, fences stripped",
        (await tomlRaw.inputValue()) === 'title = "Content inventory"\ndraft = false',
        JSON.stringify(await tomlRaw.inputValue()),
    );
    check(
        "a TOML block gets the raw editor, not the YAML table",
        (await page.locator("#frontmatter-panel .frontmatter-table").count()) === 0,
    );
    check(
        "the TOML raw editor is labelled as TOML",
        (await tomlRaw.getAttribute("aria-label")) === "Edit metadata as TOML",
        await tomlRaw.getAttribute("aria-label"),
    );
    // Whether the block reaches the body is decided by extractFrontmatter on the
    // extension side, and this harness posts `content` and `frontmatter`
    // independently, so it cannot discriminate that. It is covered where it
    // lives, in shared/__tests__/contentTransform.test.ts.

    // Type a real edit and blur: it must come back fenced in +++, not ---.
    // The caret is placed by script rather than by End or Control+End: both
    // stop at the end of the first LINE in a macOS Chromium textarea, which
    // appends in the wrong place and still yields a correctly fenced block, so
    // the check would read as a pass on a gesture it never made. The typing and
    // the blur that commits it are real.
    await tomlRaw.evaluate((el) => {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
    });
    await tomlRaw.press("Enter");
    await tomlRaw.pressSequentially("weight = 3");
    await page.locator(".milkdown .ProseMirror").click();
    await page.waitForTimeout(200);
    check(
        "committing a TOML edit writes it back between +++ fences",
        (await lastFm()) === '+++\ntitle = "Content inventory"\ndraft = false\nweight = 3\n+++\n',
        JSON.stringify(await lastFm()),
    );
}
