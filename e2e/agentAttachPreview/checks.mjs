/**
 * The agent composer's attachment thumbnail, under the policy the editor page
 * actually carries.
 *
 * `addFiles` builds the preview with `URL.createObjectURL(file)`, so the chip's
 * `img` has a `blob:` src. The extension's `img-src` granted `cspSource`,
 * `data:` and the YouTube thumbnail host and nothing else, so that image was
 * refused and every dropped screenshot showed an empty box. Nothing caught it:
 * the Mac app's policy DOES grant `blob:` and argues for it in a comment, so
 * the two surfaces disagreed with no test comparing them, and the agent panel
 * had no browser coverage of its chips at all.
 *
 * Why this cannot be a unit test. jsdom has no image loading and no CSP, so
 * `naturalWidth` is 0 there for an image that would load and 0 for one that
 * would be refused, which is the same answer to both questions. Only a real
 * engine under a real policy tells them apart.
 *
 * Why the assertion is `naturalWidth` and not the element. A refused image
 * keeps its element and its CSS box, so `querySelector` finds it and a
 * dimension read of the BOX reports whatever the stylesheet says. The only
 * property that distinguishes "loaded" from "refused" is the intrinsic size,
 * which is why every check below reads it and none of them counts chips.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForFunction(
        () => /caret in/.test(document.querySelector(".ProseMirror")?.textContent ?? ""),
        { timeout: 10000 },
    );

    // A 1x1 red PNG. Its intrinsic size is 1, so `naturalWidth > 0` means the
    // engine decoded these bytes rather than that some placeholder has a
    // width. Inline so the suite needs no fixture file on disk.
    const PNG_BASE64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

    // Open the composer the way a reader does. `/ai-advanced` rather than
    // `/ai`, because its whole purpose is the composer ("Enter opens the
    // composer", registry.ts) where `/ai` reaches it only via the empty-prompt
    // branch of `askAgent`. Testing through the row that MEANS this keeps the
    // suite pointed at the thumbnail rather than at that branch's behaviour.
    //
    // The caret has to start at the beginning of the block: the slash menu
    // opens on a `/` that begins a token, and appending gives `paragraph./ai`,
    // which does not. The row must then be COMMITTED with Space before Enter,
    // and the keystrokes carry a delay, both of which `e2e/agentGutter` learned
    // the hard way; typing it in one burst leaves the menu open and does
    // nothing.
    await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror p");
        const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
        document.querySelector(".ProseMirror").focus();
        const range = document.createRange();
        range.setStart(node, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await page.waitForTimeout(120);
    await page.keyboard.type("/ai-advanced", { delay: 60 });
    await page.waitForTimeout(250);

    // Each step asserts it reached its subject, so a failure names the step
    // that broke rather than reporting only that no panel appeared. Two
    // earlier drafts of this suite failed here for reasons that had nothing to
    // do with the policy under test, and read exactly like the finding.
    // `.ProseMirror .slash-query` and not `.slash-menu`: the menu's root can
    // sit in the DOM while hidden, so its mere presence is a check that passes
    // whether or not a query is live. `e2e/slashMenu` establishes the query
    // decoration as the discriminating signal by asserting it is null after a
    // dismissal, which is the property this needs.
    const query = await page.evaluate(
        () => document.querySelector(".ProseMirror .slash-query")?.textContent ?? null);
    check("a slash query is live, so the row can be committed", query !== null, String(query));

    await page.keyboard.press("Space");
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");

    const panel = await page.waitForSelector(".agent-panel", { timeout: 5000 }).catch(() => null);
    check("the composer opened, so there is a picker to drive", panel !== null);
    if (!panel) { return; }

    // The picker is a real <input type=file>, so the file arrives through the
    // same `change` handler a person's drop or click goes through. Nothing
    // here calls `addFiles` directly: a preview built by a harness reaching
    // past the UI would prove nothing about the path that ships.
    await page.setInputFiles("input.agent-panel-file-input", {
        name: "screenshot.png",
        mimeType: "image/png",
        buffer: Buffer.from(PNG_BASE64, "base64"),
    });

    const img = await page.waitForSelector(".agent-panel-chip img", { timeout: 5000 })
        .catch(() => null);
    check("the chip carries a thumbnail element", img !== null);
    if (!img) { return; }

    // The instrument before the finding: a src that is not a blob URL would
    // mean the preview stopped being an object URL, and then this suite is
    // measuring something else entirely and its verdict is not about the
    // policy at all.
    const src = await page.evaluate(
        () => document.querySelector(".agent-panel-chip img")?.getAttribute("src") ?? "");
    check("the thumbnail is an object URL, which is what the policy has to permit",
        src.startsWith("blob:"), src.slice(0, 24));

    const decoded = await page.evaluate(async () => {
        const el = document.querySelector(".agent-panel-chip img");
        // `complete` goes true on a refusal too, so it is a way to know the
        // attempt is over rather than that it worked. Waited on for that,
        // then the size is what answers the question.
        for (let i = 0; i < 50 && !el.complete; i++) {
            await new Promise((r) => setTimeout(r, 40));
        }
        return { complete: el.complete, naturalWidth: el.naturalWidth };
    });
    check("the load attempt finished", decoded.complete === true);
    check("the thumbnail actually decoded, so the policy permitted the object URL",
        decoded.naturalWidth > 0, `naturalWidth=${decoded.naturalWidth}`);
}
