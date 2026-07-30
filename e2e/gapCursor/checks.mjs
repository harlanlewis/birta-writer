/**
 * Gap cursor (MAR-252) — real-browser truth: these are all selection/layout
 * behaviours jsdom cannot produce, and the bug they pin is silent (the caret
 * looks like it moved; the typing lands in the wrong block).
 *
 * Every case drives the same shape: place a caret, press ONE arrow (or click),
 * then type a marker and read the markdown the webview posts back. The marker
 * landing on a LINE OF ITS OWN is the whole assertion — without a gap cursor it
 * lands inside the neighbouring leaf instead, which shows up as `| ZZa | b |`
 * or `ZZconst x = 1;` rather than a bare `ZZ` line.
 *
 * The negative cases matter as much: they pin that the new keymap declines
 * everywhere it should, so ordinary navigation (cell to cell, table into the
 * paragraph below, paragraph to paragraph) is untouched.
 *
 * Carets are placed by setting the DOM selection directly rather than by
 * clicking. Clicks into a table cell do not land reliably here (the table
 * NodeView's overlay chrome sits over the cells) and Home/End do not move the
 * caret in headless Chromium on macOS — both failure modes leave the caret at
 * the document start, where several of these cases accidentally "pass".
 */

const T = "| a | b |\n| - | - |\n| 1 | 2 |\n";
const T1 = "| a1 | b1 |\n| - | - |\n| 1 | 2 |\n";
const T2 = "| a2 | b2 |\n| - | - |\n| 3 | 4 |\n";
const CODE = "```js\nconst x = 1;\n```\n";
const MARK = "ZZ";

export async function run({ page, check, baseUrl }) {
    const boot = async (doc) => {
        await page.goto(`${baseUrl}/index.html?doc=${encodeURIComponent(doc)}`);
        await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
        await page.waitForTimeout(250);
    };

    /**
     * Collapse the caret to the start/end of the nth element matching
     * `selector` inside the editor. ProseMirror reads the DOM selection back on
     * `selectionchange`, so this is an ordinary caret placement — just a
     * deterministic one.
     */
    const placeCaret = async (selector, side, nth = 0) => {
        const ok = await page.evaluate(({ selector, side, nth }) => {
            const pm = document.querySelector(".ProseMirror");
            const host = pm.querySelectorAll(selector)[nth];
            if (!host) return false;
            const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
            let first = null, last = null;
            while (walker.nextNode()) {
                first ??= walker.currentNode;
                last = walker.currentNode;
            }
            const node = side === "end" ? last : first;
            if (!node) return false;
            pm.focus();
            const range = document.createRange();
            range.setStart(node, side === "end" ? node.nodeValue.length : 0);
            range.collapse(true);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return true;
        }, { selector, side, nth });
        await page.waitForTimeout(120);
        return ok;
    };

    /** The markdown the webview posted, once it reflects the whole marker. */
    const docWithMarker = async () => {
        let last = null;
        for (let i = 0; i < 30; i++) {
            last = await page.evaluate(() => {
                const u = window.__posted.filter((m) => m.type === "update");
                return u.length ? u[u.length - 1].content : null;
            });
            if (last?.includes(MARK)) return last;
            await page.waitForTimeout(100);
        }
        return last;
    };

    const gapVisible = () => page.evaluate(() => !!document.querySelector(".ProseMirror-gapcursor"));
    /** The marker sits on a line of its own — i.e. in a real paragraph. */
    const ownLine = (doc) => doc != null && doc.split("\n").includes(MARK);
    /** The marker sits inside the line that also holds `text`. */
    const inLineWith = (doc, text) =>
        doc != null && doc.split("\n").some((l) => l.includes(text) && l.includes(MARK));

    /**
     * Run one case. `expectGap` also pins WHERE the fix comes from — a case
     * that lands right by luck (no gap cursor involved) is not the behaviour
     * being shipped.
     */
    const caseOf = async (name, { doc, caret, act, expectGap, expect }) => {
        await boot(doc);
        if (caret) {
            const placed = await placeCaret(...caret);
            check(`${name} — caret placed`, placed, `caret=${JSON.stringify(caret)}`);
        }
        if (act) await act();
        if (expectGap !== undefined) {
            const gap = await gapVisible();
            check(`${name} — gap cursor ${expectGap ? "shown" : "not shown"}`,
                gap === expectGap, `gap=${gap}`);
        }
        await page.keyboard.type(MARK, { delay: 30 });
        expect(await docWithMarker());
    };

    const arrow = (key) => async () => { await page.keyboard.press(key); };

    // ── 1. Above a leading table (ticket case B) ────────────────────────────
    await caseOf("ArrowUp from a leading table's first cell", {
        doc: `${T}\ntail paragraph\n`,
        caret: ["th", "start", 0],
        act: arrow("ArrowUp"),
        expectGap: true,
        expect: (md) => check(
            "typing above a leading table makes a new paragraph, not a header cell",
            ownLine(md) && md.includes("| a | b |"), `doc=${JSON.stringify(md)}`),
    });

    // ── 2. Below a trailing table (ticket case C) ───────────────────────────
    await caseOf("ArrowDown from a trailing table's last cell", {
        doc: `lead paragraph\n\n${T}`,
        caret: ["td", "end", 1],
        act: arrow("ArrowDown"),
        expectGap: true,
        expect: (md) => check(
            "typing below a trailing table makes a new paragraph, not a body cell",
            ownLine(md) && md.includes("| 1 | 2 |"), `doc=${JSON.stringify(md)}`),
    });

    // ── 3. Between two adjacent tables (ticket case D) ──────────────────────
    // The case prosemirror-tables actively gets wrong: its own arrow handler
    // SUCCEEDS here (Selection.near finds the next table's first cell), so the
    // stock gap-cursor plugin never sees the key.
    await caseOf("ArrowDown out of the first of two adjacent tables", {
        doc: `${T1}\n${T2}`,
        caret: ["td", "end", 1],
        act: arrow("ArrowDown"),
        expectGap: true,
        expect: (md) => {
            const lines = md?.split("\n") ?? [];
            check("the new paragraph lands between the tables, not in the second's header",
                ownLine(md)
                && lines.indexOf(MARK) > lines.indexOf("| a1 | b1 |")
                && lines.indexOf(MARK) < lines.indexOf("| a2 | b2 |"),
                `doc=${JSON.stringify(md)}`);
        },
    });

    await caseOf("ArrowUp out of the second of two adjacent tables", {
        doc: `${T1}\n${T2}`,
        caret: ["th", "start", 2],
        act: arrow("ArrowUp"),
        expectGap: true,
        expect: (md) => {
            const lines = md?.split("\n") ?? [];
            check("the new paragraph lands between the tables, not above the first",
                ownLine(md)
                && lines.indexOf(MARK) > lines.indexOf("| a1 | b1 |")
                && lines.indexOf(MARK) < lines.indexOf("| a2 | b2 |"),
                `doc=${JSON.stringify(md)}`);
        },
    });

    // ── 4. Around a code block (ticket case E, plus its mirror) ─────────────
    // Needs `createGapCursor` on the code_block spec (plugins/math.ts): a code
    // block is a textblock, so ProseMirror offers no gap beside it by default.
    await caseOf("ArrowUp from a leading code block", {
        doc: `${CODE}\ntail paragraph\n`,
        caret: [".code-block-wrapper code", "start", 0],
        act: arrow("ArrowUp"),
        expectGap: true,
        expect: (md) => check(
            "typing above a leading code block makes a new paragraph, not a line of code",
            ownLine(md) && md.includes("const x = 1;"), `doc=${JSON.stringify(md)}`),
    });

    await caseOf("ArrowDown from a trailing code block", {
        doc: `lead paragraph\n\n${CODE}`,
        caret: [".code-block-wrapper code", "end", 0],
        act: arrow("ArrowDown"),
        expectGap: true,
        expect: (md) => check(
            "typing below a trailing code block makes a new paragraph, not a line of code",
            ownLine(md) && md.includes("const x = 1;"), `doc=${JSON.stringify(md)}`),
    });

    // ── 5. Clicking the empty area around the content ───────────────────────
    // index.ts's "click outside the content" handler used
    // TextSelection.atStart/atEnd, which land inside a leading/trailing leaf.
    // The band ABOVE the content is the only pointer route to the position over
    // a leading table: the table's own top margin collapses out of `view.dom`,
    // so the editor's content box starts exactly at the table's top edge.
    const clickOutsideContent = async (side) => {
        const g = await page.evaluate(() => {
            const pm = document.querySelector(".ProseMirror").getBoundingClientRect();
            const host = document.getElementById("editor").getBoundingClientRect();
            return { pmTop: pm.y, pmBottom: pm.bottom, x: pm.x + pm.width / 2, hostTop: host.y };
        });
        // Above: land inside #editor's padding band, however deep it is — it
        // is only ~16px over a leading paragraph.
        await page.mouse.click(g.x, side > 0 ? g.pmBottom + 40 : (g.hostTop + g.pmTop) / 2);
    };
    const clickBelowContent = () => clickOutsideContent(1);
    const clickAboveContent = () => clickOutsideContent(-1);

    await caseOf("clicking below a trailing table", {
        doc: `lead paragraph\n\n${T}`,
        act: clickBelowContent,
        expectGap: true,
        expect: (md) => check(
            "typing after that click makes a new paragraph, not a body cell",
            ownLine(md) && md.includes("| 1 | 2 |"), `doc=${JSON.stringify(md)}`),
    });

    await caseOf("clicking below a trailing paragraph", {
        doc: "lead paragraph\n\ntail paragraph\n",
        act: clickBelowContent,
        expectGap: false,
        expect: (md) => check(
            "a document ending in text is unaffected — caret goes to the end of the text",
            md?.includes(`tail paragraph${MARK}`) === true, `doc=${JSON.stringify(md)}`),
    });

    await caseOf("clicking above a leading table", {
        doc: `${T}\ntail paragraph\n`,
        act: clickAboveContent,
        expectGap: true,
        expect: (md) => check(
            "typing after that click makes a new paragraph, not a header cell",
            ownLine(md) && md.includes("| a | b |"), `doc=${JSON.stringify(md)}`),
    });

    await caseOf("clicking above a leading paragraph", {
        doc: "lead paragraph\n\ntail paragraph\n",
        act: clickAboveContent,
        expectGap: false,
        expect: (md) => check(
            "a document starting with text is unaffected — caret goes to the start of the text",
            md?.includes(`${MARK}lead paragraph`) === true, `doc=${JSON.stringify(md)}`),
    });

    // ── 6. Negative cases: ordinary navigation must be untouched ────────────
    await caseOf("ArrowDown inside a table", {
        doc: `${T}\ntail paragraph\n`,
        caret: ["th", "end", 0],
        act: arrow("ArrowDown"),
        expectGap: false,
        expect: (md) => check(
            "the caret moves header cell → body cell, no gap cursor in between",
            !ownLine(md) && inLineWith(md, "| 2 |"), `doc=${JSON.stringify(md)}`),
    });

    await caseOf("ArrowDown out of a table followed by a paragraph", {
        doc: `${T}\ntail paragraph\n`,
        caret: ["td", "end", 1],
        act: arrow("ArrowDown"),
        expectGap: false,
        expect: (md) => check(
            "a text position on the other side means no gap — the caret enters the paragraph",
            !ownLine(md) && inLineWith(md, "tail paragraph"), `doc=${JSON.stringify(md)}`),
    });

    await caseOf("ArrowDown between two paragraphs", {
        doc: "first para\n\nsecond para\n",
        caret: ["p", "start", 0],
        act: arrow("ArrowDown"),
        expectGap: false,
        expect: (md) => check(
            "the caret enters the second paragraph, no gap cursor",
            md?.includes(`${MARK}second para`) === true, `doc=${JSON.stringify(md)}`),
    });

    // ── 7. Mod-Enter / Mod-Shift-Enter (insertParagraph.ts) unchanged ───────
    await caseOf("Mod-Shift-Enter from a leading table", {
        doc: `${T}\ntail paragraph\n`,
        caret: ["th", "start", 0],
        act: async () => { await page.keyboard.press("Meta+Shift+Enter"); },
        expect: (md) => {
            const lines = md?.split("\n") ?? [];
            check("insertParagraphBefore still inserts above the table",
                ownLine(md) && lines.indexOf(MARK) < lines.indexOf("| a | b |"),
                `doc=${JSON.stringify(md)}`);
        },
    });

    await caseOf("Mod-Enter from a trailing table", {
        doc: `lead paragraph\n\n${T}`,
        caret: ["td", "end", 1],
        act: async () => { await page.keyboard.press("Meta+Enter"); },
        expect: (md) => {
            const lines = md?.split("\n") ?? [];
            check("insertParagraphAfter still inserts below the table",
                ownLine(md) && lines.indexOf(MARK) > lines.indexOf("| 1 | 2 |"),
                `doc=${JSON.stringify(md)}`);
        },
    });

    // ── 8. The caret is themed from --vscode-*, not the package's black ─────
    // prosemirror-gapcursor's own stylesheet hardcodes `border-top: 1px solid
    // black`; importing it as-is would be invisible on a dark theme.
    await boot(`${T}\ntail paragraph\n`);
    await placeCaret("th", "start", 0);
    const tableTopBefore = await page.$eval(".ProseMirror table", (el) => el.getBoundingClientRect().y);
    await page.keyboard.press("ArrowUp");
    // The caret widget is a real element in the flow, so it has to occupy no
    // space: showing it must not push the document down (style.css lays it out
    // at height 0 rather than the package's `position: absolute`, which would
    // need a positioned ancestor the editor does not have).
    const tableTopAfter = await page.$eval(".ProseMirror table", (el) => el.getBoundingClientRect().y);
    check("showing the gap caret does not move the block it sits against",
        tableTopBefore === tableTopAfter, `before=${tableTopBefore} after=${tableTopAfter}`);
    const caret = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror-gapcursor");
        if (!el) return null;
        const after = getComputedStyle(el, "::after");
        return {
            color: after.borderTopColor,
            themeCursor: getComputedStyle(document.documentElement)
                .getPropertyValue("--vscode-editorCursor-foreground").trim(),
            visible: getComputedStyle(el).display !== "none",
        };
    });
    check("the gap caret is painted in the theme's cursor color, not a literal",
        caret !== null && caret.color === "rgb(174, 175, 173)",
        `caret=${JSON.stringify(caret)}`);
    check("the gap caret is visible while the editor has focus",
        caret?.visible === true, `caret=${JSON.stringify(caret)}`);
}
