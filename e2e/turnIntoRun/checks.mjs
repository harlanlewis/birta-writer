/**
 * Multi-block Turn-into (MAR-115) end-to-end, against the production bundle:
 * a block range built with the real chords (Escape, Shift+Down), the block
 * menu opened over it through the contributed command AND through a covered
 * block's gutter marker, one row converting the whole run, and one Cmd+Z
 * bringing the original document back. The document the host receives is
 * read off the stubbed `update` messages, so the assertion is on the bytes
 * the file would hold, not on the DOM.
 */
async function latestDoc(page, matcher, tries = 30) {
    for (let i = 0; i < tries; i++) {
        const updates = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content));
        const last = updates[updates.length - 1];
        if (last && matcher(last)) return last;
        await page.waitForTimeout(100);
    }
    return null;
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);

    const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(60); };
    const clickWord = async (word) => {
        const pt = await page.evaluate((w) => {
            const pm = document.querySelector(".milkdown .ProseMirror");
            const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const idx = node.textContent.indexOf(w);
                if (idx >= 0) {
                    const r = document.createRange();
                    r.setStart(node, idx + 1); r.setEnd(node, idx + 2);
                    const b = r.getBoundingClientRect();
                    return { x: b.x + 1, y: b.y + b.height / 2 };
                }
            }
            return null;
        }, word);
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(80);
    };
    const selectedText = () =>
        page.evaluate(() => getSelection().toString().replace(/\s+/g, " ").trim());
    const menuState = () =>
        page.evaluate(() => {
            const menu = document.querySelector(".block-menu");
            if (!menu) return null;
            return {
                header: menu.querySelector(".block-menu-header")?.textContent ?? null,
                rows: Array.from(menu.querySelectorAll(".block-menu-item-label")).map((el) => el.textContent),
                active: Array.from(menu.querySelectorAll(".block-menu-item--active .block-menu-item-label"))
                    .map((el) => el.textContent),
            };
        });
    const pickRow = async (label) => {
        const ok = await page.evaluate((l) => {
            const row = Array.from(document.querySelectorAll(".block-menu .block-menu-item"))
                .find((el) => el.querySelector(".block-menu-item-label")?.textContent === l);
            if (!row) return false;
            row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            return true;
        }, label);
        await page.waitForTimeout(150);
        return ok;
    };
    const openViaCommand = () =>
        page.evaluate(() => window.postMessage({ type: "editorCommand", command: "openBlockMenu" }, "*"));

    // ── 1. Build a three-block range and open the menu over it (keyboard) ──
    await clickWord("Alpha");
    await press("Escape");
    await press("Shift+ArrowDown");
    await press("Shift+ArrowDown");
    check("Escape + 2×Shift+Down covers three blocks",
        (await selectedText()) === "Alpha para Beta para Gamma quote", await selectedText());
    await openViaCommand();
    await page.waitForTimeout(150);
    let menu = await menuState();
    check("the menu names the run", menu?.header === "Turn 3 blocks into", JSON.stringify(menu));
    check("no row is current on a mixed run", menu !== null && menu.active.length === 0, JSON.stringify(menu?.active));
    check("the run offers the intersection (Blockquote in, Code Block in)",
        menu !== null && menu.rows.includes("Blockquote") && menu.rows.includes("Code Block"), JSON.stringify(menu?.rows));

    // ── 2. One row converts every covered block, and consolidates the run ──
    check("Bullet List row picked", await pickRow("Bullet List"));
    const listed = await latestDoc(page, (doc) => doc.includes("- Alpha para"));
    check("the three blocks are ONE bullet list, the quote unwrapped into an item; Omega untouched",
        listed?.trim() === "- Alpha para\n- Beta para\n- Gamma quote\n\nOmega para", JSON.stringify(listed));
    check("the run stays selected as a block range",
        (await selectedText()) === "Alpha para Beta para Gamma quote", await selectedText());

    // ── 3. One undo restores the whole run ──
    await press("Meta+z");
    const restored = await latestDoc(page, (doc) => doc.startsWith("Alpha para\n\nBeta"));
    check("one Cmd+Z restores the original three blocks",
        restored?.trim() === "Alpha para\n\nBeta para\n\n> Gamma quote\n\nOmega para", JSON.stringify(restored));

    // ── 4. A covered block's gutter marker opens the same run menu (mouse) ──
    await clickWord("Alpha");
    await press("Escape");
    await press("Shift+ArrowDown");
    check("two-block range for the marker path", (await selectedText()) === "Alpha para Beta para");
    const marker = await page.evaluate(() => {
        // The covered markers surface while a range is live; the second
        // block's marker is the one whose menu must still be the run's.
        const blocks = Array.from(document.querySelectorAll(".ProseMirror > *"));
        const beta = blocks.find((el) => el.textContent.includes("Beta para"));
        const el = beta?.querySelector(".heading-fold-marker");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    check("Beta's marker is on screen", marker !== null);
    await page.mouse.click(marker.x, marker.y);
    await page.waitForTimeout(150);
    menu = await menuState();
    check("clicking a covered marker opens the run's menu", menu?.header === "Turn 2 blocks into", JSON.stringify(menu));
    check("Heading 2 row picked", await pickRow("Heading 2"));
    const headed = await latestDoc(page, (doc) => doc.startsWith("## Alpha para"));
    check("both covered blocks became headings, the quote below untouched",
        headed?.trim() === "## Alpha para\n\n## Beta para\n\n> Gamma quote\n\nOmega para", JSON.stringify(headed));

    // ── 5. A single-block range keeps the single-block menu ──
    await press("Escape");
    await clickWord("Omega");
    await press("Escape");
    await openViaCommand();
    await page.waitForTimeout(150);
    menu = await menuState();
    check("a one-block range gets the ordinary Turn into menu with its current row",
        menu?.header === "Turn into" && menu.active.includes("Paragraph"), JSON.stringify(menu));
    await press("Escape");
}
