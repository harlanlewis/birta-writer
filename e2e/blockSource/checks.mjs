/**
 * Source-peek end to end (MAR-20), against the real bundle.
 *
 * The plugin registers `handleKeyDown`, so a prop-level test would bypass the
 * layer the behavior actually lives in: these are real key events on a real
 * page.
 *
 * The load-bearing check is "committing an untouched block changes nothing".
 * The fixture's `[^1]` and `[ref]` resolve against definitions elsewhere in
 * the document, so a commit that parsed the block in isolation would escape
 * their brackets and this check would catch it. It runs SECOND, after a real
 * edit has posted an update: compared against a document nothing has changed
 * yet, both sides are null and the check passes without discriminating.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    /** Put the caret in the paragraph holding `needle`, by clicking it. */
    const caretInParagraph = async (needle) => {
        await page.click(`.ProseMirror > p:has-text("${needle}")`);
        await page.waitForTimeout(150);
    };

    /** Open the panel and wait until it actually holds focus. */
    const openPanel = async () => {
        // The opening chord is a contributed VS Code keybinding, so what the
        // webview actually receives is the command. Driving the chord here
        // would test the harness page, not the product.
        await page.evaluate(() =>
            window.postMessage({ type: "editorCommand", command: "editBlockSource" }, "*"),
        );
        await page.waitForSelector(".ProseMirror .block-source-area", { timeout: 5000 });
        await page.waitForFunction(
            () => document.activeElement === document.querySelector(".ProseMirror .block-source-area"),
            { timeout: 5000 },
        );
    };

    const panelGone = () =>
        page.evaluate(() => document.querySelector(".ProseMirror .block-source-area") === null);

    // ── Opening ─────────────────────────────────────────────────────────────
    await caretInParagraph("A claim citing a note");
    await openPanel();

    const source = await page.evaluate(
        () => document.querySelector(".ProseMirror .block-source-area").value,
    );
    check(
        "the panel holds the block's own Markdown",
        source.includes("A claim citing a note"),
        source,
    );
    check(
        "a document-scoped reference is spelled unescaped in the panel",
        source.includes("[^1]") && !source.includes("\\[^1]"),
        source,
    );

    const hidden = await page.evaluate(
        () => document.querySelectorAll(".ProseMirror .block-source-hidden").length,
    );
    check("the block it stands in for is hidden", hidden === 1, String(hidden));

    // The shortcut that opened the panel closes it again.
    await page.keyboard.press("Meta+/");
    await page.waitForTimeout(300);
    check("Cmd+/ from inside the panel closes it", await panelGone(), "textarea still present");

    // ── Escape cancels ──────────────────────────────────────────────────────
    await caretInParagraph("A claim citing a note");
    await openPanel();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    check("Escape closes the panel", await panelGone(), "textarea still present");
    check(
        "Escape leaves the document alone",
        (await latest()) === null,
        `posted an update: ${await latest()}`,
    );

    // ── Editing the source rewrites the block ───────────────────────────────
    // First, so that the no-op check below has a non-null document to be
    // compared against.
    await caretInParagraph("A second paragraph");
    await openPanel();
    const standIn = await page.evaluate(() => ({
        hidden: document.querySelectorAll(".ProseMirror .block-source-hidden").length,
        value: document.querySelector(".ProseMirror .block-source-area").value,
    }));
    check(
        "the panel stands in for the paragraph the caret was in",
        standIn.hidden === 1 && standIn.value.startsWith("A second paragraph"),
        JSON.stringify(standIn),
    );

    await page.evaluate(() => {
        const area = document.querySelector(".ProseMirror .block-source-area");
        area.value = "## Promoted to a heading";
        area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(600);

    const edited = await latest();
    check(
        "edited source replaces the block rather than adding to it",
        edited !== null &&
            edited.includes("## Promoted to a heading") &&
            !edited.includes("A second paragraph."),
        String(edited),
    );
    check(
        "the rest of the document survives the edit",
        edited !== null && edited.includes("[^1]: The note body.") && edited.includes("# Heading"),
        String(edited),
    );
    check("the panel closes on commit", await panelGone(), "textarea still present");

    // ── A selection spanning blocks opens them together ─────────────────────
    // The CHANGELOG claims this, so it gets driven rather than inferred from
    // the range arithmetic.
    await page.evaluate(() => {
        const blocks = [...document.querySelectorAll(".ProseMirror > *")];
        const first = blocks.find((el) => el.textContent.includes("Heading"));
        const second = blocks.find((el) => el.textContent.includes("A claim citing a note"));
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(second, second.childNodes.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(150);
    await openPanel();
    const spanning = await page.evaluate(() => ({
        hidden: document.querySelectorAll(".ProseMirror .block-source-hidden").length,
        value: document.querySelector(".ProseMirror .block-source-area").value,
    }));
    check(
        "a selection spanning two blocks opens both in one panel",
        spanning.hidden === 2 &&
            spanning.value.includes("# Heading") &&
            spanning.value.includes("A claim citing a note"),
        JSON.stringify(spanning),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── The editor's own block-selection grammar reaches it ─────────────────
    // Escape escalates a caret to a BlockRangeSelection, which sits at
    // depth-0 boundaries and has no caret inside a block to walk up from.
    // Deriving the range from the caret's depth silently excluded every
    // gesture that produces one: Escape, the marquee, the Cmd+A ladder.
    await caretInParagraph("A claim citing a note");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await openPanel();
    const fromBlockRange = await page.evaluate(() => ({
        hidden: document.querySelectorAll(".ProseMirror .block-source-hidden").length,
        value: document.querySelector(".ProseMirror .block-source-area").value,
    }));
    check(
        "a block selected with Escape opens in the panel",
        fromBlockRange.hidden === 1 && fromBlockRange.value.includes("A claim citing a note"),
        JSON.stringify(fromBlockRange),
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ── Committing an untouched block is a no-op ─────────────────────────────
    await caretInParagraph("A claim citing a note");
    await openPanel();
    await page.keyboard.press("Meta+Enter");
    await page.waitForTimeout(600);

    const afterNoop = await latest();
    check(
        "committing an untouched block changes nothing",
        afterNoop !== null && afterNoop === edited,
        `edited=${JSON.stringify(edited)} after=${JSON.stringify(afterNoop)}`,
    );
    check(
        "the footnote reference is not escaped by the round trip",
        afterNoop !== null && afterNoop.includes("[^1]") && !afterNoop.includes("\\[^1]"),
        String(afterNoop),
    );
    check(
        "the reference link is not escaped by the round trip",
        afterNoop !== null && !afterNoop.includes("\\[reference link]"),
        String(afterNoop),
    );
}
