/**
 * Smart select end-to-end (MAR-98, MAR-105), driven through the REAL chords
 * (macOS: Ctrl+Shift+Cmd+Arrow) rather than the commands: the keymap plugin
 * is where the expand memo lives, so only a keyboard run proves that shrink
 * retraces what expand did. The selection is read off the DOM selection
 * (ProseMirror mirrors every selection type into it, and hides the block
 * range visually with `.ProseMirror-hideselection`, which is how "block
 * range" is told from "text" here).
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(200);

    const selected = () =>
        page.evaluate(() => {
            const text = getSelection().toString().replace(/\s+/g, " ").trim();
            const hidden = document.querySelector(".ProseMirror").classList.contains("ProseMirror-hideselection");
            return { text, kind: hidden ? "blockRange" : "text" };
        });
    const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(60); };
    const expand = () => press("Control+Shift+Meta+ArrowRight");
    const shrink = () => press("Control+Shift+Meta+ArrowLeft");
    const clickWord = async (word, offset) => {
        const pt = await page.evaluate(({ w, o }) => {
            const pm = document.querySelector(".milkdown .ProseMirror");
            const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const idx = node.textContent.indexOf(w);
                if (idx >= 0) {
                    const r = document.createRange();
                    r.setStart(node, idx + o); r.setEnd(node, idx + o + 1);
                    const b = r.getBoundingClientRect();
                    return { x: b.x + 1, y: b.y + b.height / 2 };
                }
            }
            return null;
        }, { w: word, o: offset });
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(80);
    };

    // ── 1. A run from a caret inside a nested list item, and its retrace ──
    await clickWord("words", 1);
    const up = [];
    for (let i = 0; i < 5; i++) { await expand(); up.push((await selected()).text); }
    check("expand climbs word → block text → enclosing item → list (block range) → everything",
        JSON.stringify(up) === JSON.stringify([
            "words", "two words", "one two words", "one two words three",
            "Alpha para one two words three Omega para",
        ]), JSON.stringify(up));
    const down = [];
    for (let i = 0; i < 4; i++) { await shrink(); down.push((await selected()).text); }
    check("shrink retraces the run rung by rung",
        JSON.stringify(down) === JSON.stringify(["one two words three", "one two words", "two words", "words"]),
        JSON.stringify(down));

    // ── 2. A two-block range expanded to everything shrinks back to the range ──
    await clickWord("Alpha", 1);
    await press("Escape");                 // block range over "Alpha para"
    await press("Shift+ArrowDown");        // extend to the list
    const two = await selected();
    check("Escape + Shift+Down builds a two-block range", two.kind === "blockRange" && two.text === "Alpha para one two words three", JSON.stringify(two));
    await expand();
    check("expand → everything", (await selected()).text === "Alpha para one two words three Omega para");
    await shrink();
    const back = await selected();
    check("shrink returns to the two-block range, not one unit",
        back.kind === "blockRange" && back.text === "Alpha para one two words three", JSON.stringify(back));
}
