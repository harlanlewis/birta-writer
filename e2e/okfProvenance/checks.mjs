/**
 * The frontmatter panel's provenance label, against the real bundle.
 *
 * Three of these need an engine and cannot be asked of jsdom: that the label
 * is laid out rather than merely attached, that the collapsed panel keeps it
 * (the cascade decides that, and it is the whole reason the label rides in the
 * bottom row), and that it is painted in the muted ink rather than as an alarm.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector("#frontmatter-panel .frontmatter-table", { timeout: 10000 });
    await page.waitForTimeout(200);

    const label = page.locator("#frontmatter-panel .fm-provenance");

    // ── 1. The words: the status claimed, the tier earned, the deadline passed ──
    check("a block carrying OKF provenance draws exactly one label", (await label.count()) === 1);
    const text = (await label.textContent()) ?? "";
    check("the label names the declared status", text.includes("Stable"), text);
    check("a human signature reads as human-verified", text.includes("Human-verified"), text);
    check("a passed deadline names the day the file spells", text.includes("Stale since 2020-03-12"), text);

    // ── 2. Laid out, not merely attached ──
    const box = await label.boundingBox();
    check("the label occupies real space", box !== null && box.width > 0 && box.height > 0, JSON.stringify(box));

    // ── 3. A label, not a control ──
    const looks = await label.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
            border: cs.borderTopWidth,
            cursor: cs.cursor,
            color: cs.color,
            buttons: el.querySelectorAll("button").length,
        };
    });
    check("the label has no frame of its own", looks.border === "0px", looks.border);
    check("the label offers no pointer affordance", looks.cursor !== "pointer", looks.cursor);
    check("the label holds no control", looks.buttons === 0, String(looks.buttons));

    // The muted description ink, which is what the harness sets
    // --vscode-descriptionForeground to. Staleness is carried by the words, so
    // the label must not be painted in an alarm colour (see
    // docs/DESIGN_PRINCIPLES.md: hue names the source of a finding).
    const editorInk = await page
        .locator("#frontmatter-panel .fm-add-btn")
        .evaluate((el) => getComputedStyle(el).color);
    check("the label takes the muted ink", looks.color === "rgb(153, 153, 153)", looks.color);
    check("the label is no louder than the row's own chips", looks.color === editorInk, `${looks.color} vs ${editorInk}`);

    // ── 4. The row still reads as a row: buttons first, on one line ──
    const geometry = await page.evaluate(() => {
        const row = document.querySelector("#frontmatter-panel .fm-add-row");
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        return {
            lastClass: row.children[row.children.length - 1].className,
            toggleTop: r(".fm-toggle-btn").top,
            addTop: r(".fm-add-btn").top,
            labelLeft: r(".fm-provenance").left,
            addRight: r(".fm-add-btn").right,
        };
    });
    check("the label is the row's last item", geometry.lastClass === "fm-provenance", geometry.lastClass);
    check("the row's buttons stay on one line", Math.abs(geometry.toggleTop - geometry.addTop) < 1);
    check("the label follows the buttons", geometry.labelLeft >= geometry.addRight, `${geometry.labelLeft} vs ${geometry.addRight}`);

    // ── 5. Collapsing the panel keeps the label ──
    await page.locator("#frontmatter-panel .fm-toggle-btn").click();
    await page.waitForTimeout(150);
    const collapsed = await page.evaluate(() => ({
        panel: document.querySelector("#frontmatter-panel").classList.contains("collapsed"),
        table: getComputedStyle(document.querySelector(".frontmatter-table")).display,
    }));
    check("the toggle collapsed the panel", collapsed.panel === true);
    check("collapsing hides the table", collapsed.table === "none", collapsed.table);
    check("collapsing keeps the provenance label visible", await label.isVisible());
    const collapsedBox = await label.boundingBox();
    check(
        "the collapsed label still occupies space",
        collapsedBox !== null && collapsedBox.width > 0,
        JSON.stringify(collapsedBox),
    );

    // ── 6. Reading provenance never writes it ──
    const edits = await page.evaluate(() =>
        window.__posted.filter((m) => m.type === "frontmatterUpdate").length,
    );
    check("drawing the label posts no frontmatter edit", edits === 0, String(edits));

    // ── 7. Ordinary frontmatter earns no label at all ──
    await page.goto(`${baseUrl}/index.html?plain=1`);
    await page.waitForSelector("#frontmatter-panel .frontmatter-table", { timeout: 10000 });
    await page.waitForTimeout(200);
    check(
        "frontmatter with no OKF field draws no label",
        (await page.locator("#frontmatter-panel .fm-provenance").count()) === 0,
    );
    check(
        "that panel is still a panel",
        (await page.locator("#frontmatter-panel .fm-add-btn").count()) === 1,
    );
}
