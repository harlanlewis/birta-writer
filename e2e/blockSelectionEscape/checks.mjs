/**
 * Escape from a whole-document block range returns the caret to where the
 * reader was (MAR-461), driven through the real keydown path.
 *
 * The unit tests pin the commands; this pins that the keys reach them and
 * that nothing between ProseMirror's keydown and the next paint re-places the
 * caret. The assertion is where a typed marker lands, read from the markdown
 * the page posts back, because that is the only thing the reader sees: a
 * caret at position 1 is invisible until the next keystroke goes to the top
 * of the file.
 *
 * The negative case is deliberate. The ladder is a considered interaction
 * contract, and this suite would pass on a fix that made Escape ALWAYS return
 * somewhere plausible; it has to fail on the old collapse-to-start as well,
 * which the marker landing in paragraph one is.
 */

const MARK = "ZZ";
const COUNT = 40;
const TARGET = 25; // one-based paragraph the caret starts in

export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const doc = Array.from({ length: COUNT }, (_, i) => `paragraph ${i + 1}`).join("\n\n") + "\n";
    await page.goto(`${baseUrl}/index.html?doc=${encodeURIComponent(doc)}`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(250);

    // Caret placed through the DOM selection rather than a click, so it is
    // deterministic (clicks are not, on the overlay chrome). Its own reach is
    // asserted: a caret that silently stayed at the top would make the old
    // behaviour and the new one indistinguishable.
    const placed = await page.evaluate((nth) => {
        const pm = document.querySelector(".ProseMirror");
        const host = pm.querySelectorAll(":scope > p")[nth];
        if (!host) return false;
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text || text.nodeValue.length < 4) return false;
        pm.focus();
        const range = document.createRange();
        range.setStart(text, 3);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
    }, TARGET - 1);
    check("caret placed mid-document", placed, `paragraph ${TARGET} of ${COUNT}`);
    await page.waitForTimeout(120);

    // Read off the live view. A missing probe THROWS rather than returning
    // null: every later check compares two of these, and two nulls agree,
    // which would pass the suite over nothing.
    const selection = async () => {
        const s = await page.evaluate(() => {
            const view = window.__birtaPerf?.view?.();
            if (!view) return null;
            const s = view.state.selection;
            return { type: s.toJSON().type, from: s.from, to: s.to, size: view.state.doc.content.size };
        });
        if (!s) throw new Error("__birtaPerf.view is not installed on this page; set window.__perfInit in index.html before the bundle loads");
        return s;
    };

    const before = await selection();
    check("caret starts as a text selection past the top of the file", before.type === "text" && before.from > 1,
        JSON.stringify(before));

    await page.keyboard.press("Meta+a"); // 1: the block's text
    await page.keyboard.press("Meta+a"); // 2: the block
    await page.keyboard.press("Meta+a"); // 3: every block
    const all = await selection();
    check("three Mod+A reach the whole-document block range",
        all?.type === "blockRange" && all.from === 0 && all.to === all.size, JSON.stringify(all));

    await page.keyboard.press("Escape");
    const after = await selection();
    check("Escape collapses the range", after?.type === "text" && after.from === after.to, JSON.stringify(after));
    check("the caret is back where the reader was, not at the top of the file",
        after?.from === before?.from, `before=${before?.from} after=${after?.from}`);

    // The reader's own proof: the next keystroke lands in the paragraph they
    // were in. A caret at position 1 puts it at the top of the file.
    await page.keyboard.type(MARK, { delay: 30 });
    let md = null;
    for (let i = 0; i < 30 && !(md ?? "").includes(MARK); i++) {
        await page.waitForTimeout(100);
        md = await page.evaluate(() => {
            const u = window.__posted.filter((m) => m.type === "update");
            return u.length ? u[u.length - 1].content : null;
        });
    }
    // The caret sat three characters into "paragraph N", so the marker splits
    // the word: the line that carries it must be the target's, read by the
    // number that survives the split.
    const lines = (md ?? "").split("\n");
    const landed = lines.findIndex((l) => l.includes(MARK));
    check("typing after Escape lands in the paragraph the reader was in",
        landed >= 0 && lines[landed].endsWith(`agraph ${TARGET}`) && !lines[0].includes(MARK),
        `marker on line ${landed + 1}: ${JSON.stringify(lines[landed] ?? null)}; line 1 is ${JSON.stringify(lines[0])}`);
}
