/**
 * Image NodeView end-to-end checks: alt caption, always-visible title row,
 * path editing (apply on blur / Escape cancels), file-name chip, selection
 * theming, and serialization of every edit into the posted markdown.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".image-wrapper img.image-node", { timeout: 10000 });
    await page.waitForTimeout(400);

    const wrappers = page.locator(".image-wrapper");
    const first = wrappers.nth(0); // ![two cats](img/cats.jpeg "Sleepy tabbies")
    const second = wrappers.nth(1); // ![](img/other.jpeg)
    const updates = () =>
        page.evaluate(() => window.__posted.filter((m) => m.type === "update").map((m) => m.content));

    // ── 1. Caption visibility ────────────────────────────────
    const cap1 = first.locator(".image-caption");
    const cap2 = second.locator(".image-caption");
    check("caption with alt is visible without selection", await cap1.isVisible());
    check("caption value shows the alt text", (await cap1.inputValue()) === "two cats");
    check("empty-alt caption is hidden without selection", !(await cap2.isVisible()));

    await second.locator("img").click();
    await page.waitForTimeout(100);
    check("empty-alt caption is revealed on selection", await cap2.isVisible());
    check("toolbar appears on selection", await second.locator(".image-toolbar").isVisible());
    check(
        "toolbar has no ALT button",
        (await second.locator(".image-toolbar").textContent()).indexOf("ALT") === -1,
    );

    // ── 2. Caption editing: apply on blur ────────────────────
    await cap2.click();
    await cap2.fill("added alt");
    await page.locator(".ProseMirror p").last().click(); // click away → blur
    await page.waitForTimeout(600);
    let posted = await updates();
    check(
        "caption blur committed alt into markdown",
        posted.length > 0 && posted[posted.length - 1].includes("![added alt]("),
        JSON.stringify(posted[posted.length - 1] ?? "(no update)").slice(0, 120),
    );

    // ── 3. Caption Escape reverts ────────────────────────────
    await first.locator("img").click();
    await cap1.click();
    await cap1.fill("should be discarded");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check("Escape restores the original caption text", (await cap1.inputValue()) === "two cats");
    posted = await updates();
    check(
        "Escape did not commit the abandoned caption",
        !posted.some((u) => u.includes("should be discarded")),
    );

    // ── 4. Caption Enter commits ─────────────────────────────
    await cap1.click();
    await cap1.fill("two tabby cats");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "Enter committed the edited caption",
        posted.some((u) => u.includes("![two tabby cats](")),
    );

    // ── 5. Selection theming + phantom-selection suppression ─
    await first.locator("img").click();
    await page.waitForTimeout(150);
    const borderColor = await first.evaluate((el) => getComputedStyle(el).borderColor);
    check("selected border uses the theme focusBorder", borderColor === "rgb(0, 127, 212)", borderColor);
    for (const [name, loc] of [["caption", cap1], ["title row", first.locator(".img-tb-title")]]) {
        const sel = await loc.evaluate((el) => getComputedStyle(el, "::selection").backgroundColor);
        check(
            `${name} suppresses selection paint while the node is selected`,
            sel === "rgba(0, 0, 0, 0)" || sel === "transparent",
            sel,
        );
    }

    // ── 6. Title row: prefill, apply on blur, tooltip + markdown ──
    const pencil = first.locator('.image-toolbar button[aria-label="Edit Image Path"]');
    const titleRow = first.locator(".img-tb-title");
    check("title row is visible in the toolbar before any editing", await titleRow.isVisible());
    check("title row prefills from the markdown title", (await titleRow.inputValue()) === "Sleepy tabbies");
    await pencil.dispatchEvent("mousedown");
    const pathInput = first.locator(".img-path-input");
    await pathInput.waitFor({ state: "visible", timeout: 3000 });
    check("path editor opens with the relative path", (await pathInput.inputValue()) === "img/cats.jpeg");
    check("title row stays visible during path editing", await titleRow.isVisible());
    const editButtons = await first
        .locator(".image-toolbar button")
        .evaluateAll((els) => els.filter((el) => el.style.display !== "none").length);
    check("path edit mode shows no confirm/cancel buttons", editButtons === 0, `${editButtons} visible buttons`);
    // The toolbar opens this field with mousedown preventDefault, so the image
    // stays node-selected while the user types in it — and a node selection is
    // one of the states whose native caret is suppressed. The suppression must
    // stop at the form field, or the path is typed with no caret (MAR-258).
    const pathCaret = await page.evaluate(() => ({
        stillSelected: document.querySelector(".ProseMirror")
            .classList.contains("ProseMirror-hideselection"),
        caret: getComputedStyle(document.querySelector(".img-path-input")).caretColor,
    }));
    check("the path field has a caret while its image is still selected",
        pathCaret.stillSelected && pathCaret.caret !== "rgba(0, 0, 0, 0)",
        JSON.stringify(pathCaret));
    // A caret is only half of it: the field must also PAINT what it selects.
    // Checking caretColor alone let a state ship where Cmd+A selected the whole
    // path and rendered it on plain background — indistinguishable from having
    // selected nothing. Assert the observable the user actually loses.
    const pathSelPaint = await page.evaluate(() => {
        const input = document.querySelector(".img-path-input");
        input.focus();
        input.setSelectionRange(0, input.value.length);
        return {
            selLen: input.selectionEnd - input.selectionStart,
            selBg: getComputedStyle(input, "::selection").backgroundColor,
        };
    });
    check("the path field paints the text it has selected",
        pathSelPaint.selLen > 0 && pathSelPaint.selBg !== "rgba(0, 0, 0, 0)",
        JSON.stringify(pathSelPaint));

    await pathInput.fill("img/other.jpeg");
    await page.locator(".ProseMirror p").last().click(); // blur → apply
    await page.waitForTimeout(800);
    const src1 = await first.locator("img").getAttribute("src");
    check("path applied on blur (img src switched)", src1 === `${baseUrl}/img/other.jpeg`, src1);
    check("path editor closed after blur", (await first.locator(".img-path-input").count()) === 0);

    await first.locator("img").click();
    await titleRow.waitFor({ state: "visible", timeout: 3000 });
    await titleRow.fill("Edited via panel");
    await page.locator(".ProseMirror p").last().click(); // blur → apply
    await page.waitForTimeout(800);
    const imgTitle = await first.locator("img").getAttribute("title");
    check("title applied to the image tooltip", imgTitle === "Edited via panel", JSON.stringify(imgTitle));
    posted = await updates();
    check(
        "title serialized into the markdown",
        posted.some((u) => u.includes('img/other.jpeg "Edited via panel"')),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );

    // ── 7. Title round-trip edges: clearing, quotes ──────────
    await first.locator("img").click();
    await titleRow.fill("");
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "clearing the title drops it from the markdown (no empty quotes)",
        posted.some((u) => u.includes("img/other.jpeg)\n")) &&
            !posted[posted.length - 1].includes('""'),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );
    await first.locator("img").click();
    await titleRow.fill('a "quoted" title');
    await page.locator(".ProseMirror p").last().click();
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "a title containing quotes serializes escaped",
        posted.some((u) => u.includes('img/other.jpeg "a \\"quoted\\" title"')),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 140),
    );

    // ── 8. Path edit: Escape cancels ─────────────────────────
    await first.locator("img").click();
    await pencil.dispatchEvent("mousedown");
    await pathInput.waitFor({ state: "visible", timeout: 3000 });
    await pathInput.fill("img/cats.jpeg");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const srcAfterEsc = await first.locator("img").getAttribute("src");
    check("Escape cancels the path edit", srcAfterEsc === `${baseUrl}/img/other.jpeg`, srcAfterEsc);
    check("path editor closed after Escape", (await first.locator(".img-path-input").count()) === 0);

    // ── 9. File-name chip ────────────────────────────────────
    await first.locator("img").click();
    const chip = first.locator(".img-tb-path");
    check("chip shows the file name", (await chip.locator(".img-tb-path-name").textContent()) === "other.jpeg");
    check("chip carries a pencil glyph", (await chip.locator(".img-tb-path-pencil svg").count()) === 1);
    check(
        "toolbar row keeps only the editors (path chip); zoom+width live in the control column, no delete button",
        (await first.locator(".image-toolbar-row > button").count()) === 1 &&
            (await first.locator(".bc-col .img-bc-zoom").count()) === 1 &&
            (await first.locator(".bc-col .img-tb-width").count()) === 1 &&
            (await first.locator(".bc-col .img-bc-delete").count()) === 0,
    );
    await chip.dispatchEvent("mousedown");
    check("clicking the file-name chip opens the path editor", await first.locator(".img-path-input").isVisible());
    check("chip-opened editor prefills the path", (await first.locator(".img-path-input").inputValue()) === "img/other.jpeg");
    await page.keyboard.press("Escape");

    // ── 10. Path suggest dropdown (MAR-220) ──────────────────
    // The dropdown is the shared suggest list (webview/ui/suggestList.ts).
    // jsdom can't check what needs real layout and real CSS: that the rows
    // actually paint through the ui-menu-row primitive, that exactly ONE row
    // carries the selection wash, and that a list opened near the bottom edge
    // flips above its field instead of rendering off-screen.
    const suggestMenu = page.locator(".img-path-complete-menu");
    const suggestRows = suggestMenu.locator("li");

    await first.locator("img").click();
    await pencil.dispatchEvent("mousedown");
    await first.locator(".img-path-input").waitFor({ state: "visible", timeout: 3000 });
    await first.locator(".img-path-input").fill("img/");
    await suggestMenu.waitFor({ state: "visible", timeout: 3000 });

    check("typing a path opens the suggest dropdown", await suggestMenu.isVisible());
    // With room to spare, placement must leave the stylesheet's own height cap
    // alone. Applying the available space as a max-height unconditionally would
    // override .fm-suggest-list's 200px and let a tall pane grow every menu
    // past its design, which is invisible in a short-viewport test.
    check(
        "a dropdown with room to spare keeps its designed height cap",
        await page.evaluate(() => {
            const list = document.querySelector(".fm-suggest-menu .fm-suggest-list");
            return list.style.maxHeight === ""
                && list.getBoundingClientRect().height <= 200;
        }),
        await page.evaluate(() => {
            const list = document.querySelector(".fm-suggest-menu .fm-suggest-list");
            return `inline maxHeight ${JSON.stringify(list.style.maxHeight)}, height ${list.getBoundingClientRect().height}`;
        }),
    );
    check(
        "non-image files are filtered out (dir + 2 images)",
        (await suggestRows.count()) === 3,
        `${await suggestRows.count()} rows`,
    );
    check(
        "rows compose the ui-menu-row primitive",
        await suggestRows.evaluateAll((els) =>
            els.every((el) => el.classList.contains("ui-menu-row")),
        ),
    );
    check(
        "the directory row shows a folder icon and the image rows thumbnails",
        (await suggestMenu.locator(".img-complete-icon svg").count()) === 1 &&
            (await suggestMenu.locator("img.img-complete-thumb").count()) === 2,
    );
    check(
        "the thumbnail composes the radius token, not a raw 2px",
        (await suggestMenu
            .locator("img.img-complete-thumb")
            .first()
            .evaluate((el) => getComputedStyle(el).borderRadius)) === "3px",
    );

    /**
     * How many rows are painted as highlighted — counted as "background differs
     * from the menu's own ground" rather than against a hard-coded selection
     * hex. The behavior under test is that EXACTLY ONE row reads as selected;
     * which token supplies that fill is a design decision that has already
     * changed once (the suggest-widget wash became --ui-menu-selected-bg when
     * every menu moved onto one ground), and a literal here turns that into a
     * false failure while a two-highlight regression is what should fail.
     */
    const washedRows = () =>
        suggestRows.evaluateAll((els) => {
            const ground = getComputedStyle(els[0].parentElement).backgroundColor;
            return els.filter((el) => {
                const bg = getComputedStyle(el).backgroundColor;
                return bg !== ground && bg !== "rgba(0, 0, 0, 0)";
            }).length;
        });

    check("the first row is highlighted when the list opens", (await washedRows()) === 1);

    // Park the pointer on the LAST row, then move the highlight with the
    // keyboard without moving the mouse. The pointer keeps its CSS :hover on
    // that row while --focused sits elsewhere — the exact state in which the
    // old image dropdown painted two rows as selected at once.
    await suggestRows.nth(2).hover();
    check("hovering a row moves the highlight to it", (await washedRows()) === 1);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(80);
    check(
        "keyboard navigation with the pointer parked leaves exactly one row highlighted",
        (await washedRows()) === 1,
        `${await washedRows()} rows washed`,
    );
    check(
        "the highlighted row is the one the keyboard moved to",
        await suggestRows
            .nth(1)
            .evaluate((el) => el.classList.contains("fm-suggest-item--focused")),
    );

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // Viewport flip: a short viewport puts the second image's path field near
    // the bottom edge, where the pre-MAR-220 dropdown rendered off-screen.
    await page.setViewportSize({ width: 1000, height: 320 });
    await page.waitForTimeout(200);
    await second.locator("img").click();
    await second.locator(".image-toolbar").waitFor({ state: "visible", timeout: 3000 });
    await second
        .locator('.image-toolbar button[aria-label="Edit Image Path"]')
        .dispatchEvent("mousedown");
    const lowInput = second.locator(".img-path-input");
    await lowInput.waitFor({ state: "visible", timeout: 3000 });
    await lowInput.fill("img/");
    await suggestMenu.waitFor({ state: "visible", timeout: 3000 });

    const menuBox = await suggestMenu.boundingBox();
    const fieldBox = await lowInput.boundingBox();
    const vh = page.viewportSize().height;
    // The usable area's top edge, which is what placement is actually fitted
    // against: the topbar plus the sticky heading title, both fixed and opaque.
    const safeTop = await page.evaluate(() => {
        const sticky = document.querySelector(".heading-sticky-title:not([hidden])");
        const bar = document.querySelector(".editor-topbar");
        return (bar ? bar.getBoundingClientRect().height : 0)
            + (sticky ? sticky.getBoundingClientRect().height : 0);
    });
    check(
        "a dropdown near the bottom edge stays fully on screen",
        menuBox.y >= 0 && menuBox.y + menuBox.height <= vh + 1,
        `menu ${menuBox.y}..${menuBox.y + menuBox.height} of ${vh}`,
    );
    // Precondition: this pane really is too short to hold the menu above the
    // field, so the assertion below cannot pass just because there was room.
    check(
        "the short pane genuinely cannot fit the dropdown above the field",
        fieldBox.y - safeTop < menuBox.height,
        `room above ${fieldBox.y - safeTop}, menu ${menuBox.height}`,
    );
    // It does NOT flip above here, and that is correct: with a topbar and a
    // sticky heading title stacked above, the space that looks free from y=0
    // is opaque chrome, and a flipped menu would be painted over. Neither side
    // fits, so it takes the larger one and scrolls inside the room it has.
    check(
        "the dropdown never intrudes into the fixed chrome",
        menuBox.y >= safeTop,
        `menu top ${menuBox.y}, safe top ${safeTop}`,
    );

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.waitForTimeout(200);

    // ── 11. Typing in the doc still works (regression) ───────
    // Left-edge click: the second image is still selected, and its toolbar —
    // centered with the image since standalone images center in the column —
    // hangs over the tail paragraph's midpoint.
    await page.locator(".ProseMirror p").last().click({ position: { x: 10, y: 5 } });
    await page.waitForTimeout(150); // let ProseMirror settle the click's text selection
    // The edge click lands at line start; collapse to the end of the line by
    // hand rather than with End, which Chromium hands to the scroller first and
    // only lets through as a caret move when the page cannot scroll that way —
    // and #editor's tail band means it usually can.
    await page.evaluate(() => {
        const ps = document.querySelectorAll(".ProseMirror p");
        const node = ps[ps.length - 1].lastChild;
        const range = document.createRange();
        range.setStart(node, node.nodeValue.length);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(150);
    await page.keyboard.type(" appended");
    await page.waitForTimeout(600);
    posted = await updates();
    check(
        "normal typing in the document still serializes",
        posted.some((u) => u.includes("tail text appended")),
    );

    // ── 12. A selected image hides the native highlight (MAR-258) ────────────
    // Selecting an image is a NodeSelection: invisible to ProseMirror, but the
    // browser still holds a DOM selection over it and would paint the theme
    // highlight under the selection ring. The suppression is scoped to the
    // image's own block now (a `pm-hidden-selection` node decoration) instead
    // of a class on the editor root, which used to re-style the whole document
    // on every selection change — 169 ms on a 300 KB document.
    await first.locator("img").click();
    await page.waitForTimeout(150);
    const nodeSel = await page.evaluate(() => {
        const root = document.querySelector(".ProseMirror");
        const selectedBlock = root.querySelector(":scope > .pm-hidden-selection");
        const tail = [...root.children].find((el) => el.tagName === "P" && !el.className.includes("pm-hidden-selection"));
        return {
            hide: root.classList.contains("ProseMirror-hideselection"),
            marked: !!selectedBlock && !!selectedBlock.querySelector("img.image-node"),
            bg: selectedBlock ? getComputedStyle(selectedBlock, "::selection").backgroundColor : null,
            tailBg: tail ? getComputedStyle(tail, "::selection").backgroundColor : null,
            // The caption input lives inside the selected block: the caret
            // suppression must not follow the alt text the user types there.
            captionCaret: getComputedStyle(
                document.querySelector(".image-wrapper .image-caption"),
            ).caretColor,
        };
    });
    check("a selected image suppresses the native highlight on its own block",
        nodeSel.hide && nodeSel.marked && nodeSel.bg === "rgba(0, 0, 0, 0)",
        JSON.stringify(nodeSel));
    check("the rest of the document keeps its highlight while an image is selected",
        nodeSel.tailBg !== null && nodeSel.tailBg !== "rgba(0, 0, 0, 0)", JSON.stringify(nodeSel));
    check("the alt-caption field keeps a visible caret while its image is selected",
        nodeSel.captionCaret !== "rgba(0, 0, 0, 0)", JSON.stringify(nodeSel));
    await first.locator(".image-caption").click();
    await page.waitForTimeout(120);
    const focusedCaption = await page.evaluate(() => {
        const input = document.querySelector(".image-wrapper .image-caption");
        return {
            focused: document.activeElement === input,
            caret: getComputedStyle(input).caretColor,
            stillHidden: document.querySelector(".ProseMirror")
                .classList.contains("ProseMirror-hideselection"),
        };
    });
    check("typing the alt text is not caretless when the image stays selected",
        focusedCaption.focused && focusedCaption.caret !== "rgba(0, 0, 0, 0)",
        JSON.stringify(focusedCaption));
    await page.keyboard.press("Escape");

    // ── 12. Keyboard path into the toolbar inputs (MAR-118) ──
    // The block menu's Edit rows hand focus to the NodeView's editors, so
    // alt/title/path are reachable without the pointer once ⌘. opens the
    // menu (openAtCaret drives this same row path).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const pickMenuRow = async (label) => {
        // Marker order tracks the blocks: [# Sample, image 1, image 2, tail],
        // so nth(1) is the FIRST image paragraph's own marker.
        await page.locator(".heading-fold-marker").nth(1).click({ force: true });
        await page.waitForSelector(".block-menu", { state: "visible", timeout: 3000 });
        await page.evaluate((rowLabel) => {
            const row = [...document.querySelectorAll(".block-menu .block-menu-item")]
                .find((el) => el.querySelector(".block-menu-item-label")?.textContent === rowLabel);
            if (!row) { throw new Error(`no menu row: ${rowLabel}`); }
            row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        }, label);
        await page.waitForTimeout(200);
    };

    await pickMenuRow("Edit Alt Text");
    const altEntry = await page.evaluate(() => {
        const wrapper = document.querySelector(".image-wrapper");
        return {
            focused: document.activeElement === wrapper.querySelector(".image-caption"),
            selected: wrapper.classList.contains("image-wrapper--selected"),
        };
    });
    check("Edit Alt Text focuses the caption with the image selected",
        altEntry.focused && altEntry.selected, JSON.stringify(altEntry));
    await page.keyboard.type("keyboard alt");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    posted = await updates();
    check("keyboard-entered alt committed into the markdown",
        posted.some((u) => u.includes("![keyboard alt](")),
        JSON.stringify(posted[posted.length - 1] ?? "").slice(0, 120));

    await pickMenuRow("Edit Image Path");
    check("Edit Image Path opens the path editor focused", await page.evaluate(() =>
        document.activeElement === document.querySelector(".image-wrapper .img-path-input")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);

    await pickMenuRow("Fit Column Width");
    const widthAfterRow = await first.evaluate((el) => el.classList.contains("bw-fixed"));
    check("the width menu row applies the fixed width class", widthAfterRow);
    posted = await updates();
    check("the width row never dirties the file",
        !posted.some((u) => u.includes("width")));
    // The row renames to the cycle's next state; back to natural for cleanup.
    await pickMenuRow("Full Width");
    await pickMenuRow("Natural Size");
    check("width cycled back to natural",
        await first.evaluate((el) => !el.classList.contains("bw-fixed") && !el.classList.contains("bw-full")));
}
