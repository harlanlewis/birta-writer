/**
 * Markdown-paste end-to-end checks against the real bundle.
 *
 * The jsdom unit tests compose `pasteMarkdownPlugin` by hand, so they can pass
 * even if the plugin is never wired into `webview/editor.ts`; these drive the
 * production bundle, so they pin the wiring too. They also exercise the one
 * layer jsdom has no engine for: a real DOM `paste` event, and the shift-paste
 * modifier, which ProseMirror reads off its own keydown tracking rather than
 * from the paste event.
 *
 * Outbound edits land in window.__posted as `update` messages, so each check
 * asserts on the Markdown that would actually be saved.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    /** The most recent serialized document the webview posted out. */
    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    /**
     * Dispatch a real paste carrying `text` as text/plain. `shift` first sends a
     * shift-held keydown, which is where ProseMirror picks up the plain-paste
     * modifier (view.input.shiftKey) — the paste event's own shiftKey is not
     * what it reads.
     */
    const pasteText = (text, { shift = false } = {}) =>
        page.evaluate(({ t, shift }) => {
            const el = document.querySelector(".milkdown .ProseMirror");
            if (shift) {
                el.dispatchEvent(new KeyboardEvent("keydown", {
                    key: "Shift", shiftKey: true, bubbles: true, cancelable: true,
                }));
            }
            const dt = new DataTransfer();
            dt.setData("text/plain", t);
            el.dispatchEvent(new ClipboardEvent("paste", {
                clipboardData: dt, bubbles: true, cancelable: true,
            }));
        }, { t: text, shift });

    /** Put the caret at the very end of the document's first paragraph. */
    const caretToEndOfFirstParagraph = () =>
        page.evaluate(() => {
            const p = document.querySelector(".milkdown .ProseMirror p");
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(p);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
            p.closest(".ProseMirror").focus();
        });

    const settle = () => page.waitForTimeout(400);

    // ── 1. Markdown syntax pasted as plain text becomes real nodes ──
    // The pasted document leads with a paragraph: ProseMirror merges a paste's
    // FIRST block into the caret's textblock (so a heading pasted mid-sentence
    // never splits one in), and every later block keeps its own structure.
    await caretToEndOfFirstParagraph();
    await pasteText(" intro\n\n## Pasted Heading\n\n- one\n- two");
    await settle();
    const afterMd = await latest();
    check("a pasted heading is a real heading, not escaped text",
        afterMd?.includes("## Pasted Heading") && !afterMd.includes("\\#"), JSON.stringify(afterMd));
    check("a pasted list is a real list", afterMd?.includes("- one\n- two"), JSON.stringify(afterMd));
    check("the pasted heading rendered as an h2",
        (await page.locator(".ProseMirror h2").count()) > 0);

    // ── 2. Shift-paste is literal ──
    await page.reload();
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);
    await caretToEndOfFirstParagraph();
    await pasteText("\n\n## Not A Heading", { shift: true });
    await settle();
    const afterShift = await latest();
    check("shift-paste keeps the syntax literal (escaped, no heading)",
        afterShift?.includes("\\## Not A Heading"), JSON.stringify(afterShift));
    check("shift-paste added no h2", (await page.locator(".ProseMirror h2").count()) === 0);

    // ── 3. birta.pasteFormat: "plainText" is literal too ──
    await page.reload();
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.evaluate(() => { window.__i18n.pasteFormat = "plainText"; });
    await page.waitForTimeout(300);
    await caretToEndOfFirstParagraph();
    await pasteText("\n\n## Still Not A Heading");
    await settle();
    const afterSetting = await latest();
    check("pasteFormat plainText keeps the syntax literal",
        afterSetting?.includes("\\## Still Not A Heading"), JSON.stringify(afterSetting));

    // The in-code-block case is covered by the unit suite instead: ProseMirror
    // returns raw text for a code context BEFORE consulting clipboardTextParser,
    // so the assertion is about PM's own gate, and driving the caret into the
    // CodeMirror-backed block from here proved unreliable enough that the check
    // passed for the wrong reason (the paste landed in the paragraph).
}
