/**
 * Read-only mode (MAR-53) against the real production bundle.
 *
 * The claim under test is not "the toggle exists". It is "with read-only on,
 * gesture X does not change the document", so every check here drives a real
 * gesture — a keystroke through the browser's own input pipeline, a real
 * click on real chrome, a real `editorCommand` message — and then asks the two
 * questions that matter: did the serialized document move, and did the webview
 * post a write to the extension.
 *
 * `window.__posted` is the honest oracle for the second question. Every
 * document write in the webview leaves through it (`update`, `flushResult`,
 * `frontmatterUpdate`, `uploadImage`), so a mutation path nobody thought of
 * still shows up as an unexpected message. Counting messages rather than
 * diffing text is what makes the assertion an invariant instead of a
 * per-construct expectation.
 *
 * The last group is the pixel-identical constraint: the same bytes loaded
 * read-only and editable must render to the same DOM and the same geometry. If
 * a document appeared to shift on toggle, a user could not tell a render change
 * from a content change, which is the whole trust argument for the mode. It
 * doubles as the detector for a subtler failure: the transaction filter is
 * indiscriminate, so if any plugin normalized the document into its rendered
 * form with a transaction, blocking that transaction would show up right here
 * as a DOM difference.
 */

/** Every message the webview has posted, by type. */
function posted(page) {
    return page.evaluate(() => {
        const counts = {};
        for (const m of window.__posted) { counts[m.type] = (counts[m.type] ?? 0) + 1; }
        return counts;
    });
}

/** The editor's current text, as the DOM has it. */
function docText(page) {
    return page.$eval(".ProseMirror", (el) => el.innerText);
}

/**
 * Count only the messages that WRITE. A read-only session posts plenty of
 * innocent traffic (ready, viewState, wordCount, focusState), so asserting on
 * the total would be a test of the harness rather than of the lock.
 */
const WRITE_MESSAGES = ["update", "flushResult", "frontmatterUpdate", "uploadImage"];

async function writeCount(page) {
    const counts = await posted(page);
    return WRITE_MESSAGES.reduce((n, t) => n + (counts[t] ?? 0), 0);
}

/** Run `fn`, then assert neither the document text nor the write count moved. */
async function assertInert(page, check, name, fn) {
    const beforeText = await docText(page);
    const beforeWrites = await writeCount(page);
    await fn();
    await page.waitForTimeout(120);
    const afterText = await docText(page);
    const afterWrites = await writeCount(page);
    const ok = beforeText === afterText && beforeWrites === afterWrites;
    check(
        `read-only: ${name} does not change the document`,
        ok,
        ok ? "" : `writes ${beforeWrites}->${afterWrites}; text changed: ${beforeText !== afterText}`,
    );
}

/** Click the centre of the first element matching `sel`, if it exists. */
async function clickIfPresent(page, sel) {
    const box = await page.$eval(sel, (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) { return null; }
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (!box) { return false; }
    await page.mouse.click(box.x, box.y);
    return true;
}

export async function run({ page, check, baseUrl }) {
    // ── Read-only boot ──────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".ProseMirror", { timeout: 20000 });
    await page.waitForTimeout(700); // let the deferred decoration passes settle

    const contentEditable = await page.$eval(".ProseMirror", (el) => el.getAttribute("contenteditable"));
    check("read-only: the editor is not contenteditable", contentEditable === "false", String(contentEditable));

    const bodyClass = await page.evaluate(() => document.body.classList.contains("read-only"));
    check("read-only: body carries the read-only class", bodyClass === true);

    // The baseline every gesture below is measured against. A read-only boot
    // must not have written anything at all: if it had, the checks that follow
    // would be comparing against an already-broken promise.
    const bootWrites = await writeCount(page);
    check("read-only: booting writes nothing", bootWrites === 0, `writes=${bootWrites}`);

    // ── Native input ────────────────────────────────────────────────────────
    // Driven as real browser events, not as ProseMirror props: a prop-level
    // call bypasses the dispatch layer these locks actually live in.
    await page.click(".ProseMirror p");
    await assertInert(page, check, "typing", async () => {
        await page.keyboard.type("XYZZY");
    });
    await assertInert(page, check, "Enter", async () => {
        await page.keyboard.press("Enter");
    });
    await assertInert(page, check, "Backspace", async () => {
        await page.keyboard.press("Backspace");
    });
    await assertInert(page, check, "Delete", async () => {
        await page.keyboard.press("Delete");
    });
    await assertInert(page, check, "the bold shortcut", async () => {
        await page.keyboard.press("Meta+b");
    });
    await assertInert(page, check, "undo", async () => {
        await page.keyboard.press("Meta+z");
    });
    await assertInert(page, check, "a markdown input rule", async () => {
        await page.keyboard.type("## ");
    });
    await assertInert(page, check, "the slash menu trigger", async () => {
        await page.keyboard.type("/");
    });
    await assertInert(page, check, "paste", async () => {
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData("text/plain", "pasted text");
            document.querySelector(".ProseMirror").dispatchEvent(
                new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
            );
        });
    });
    await assertInert(page, check, "drop", async () => {
        await page.evaluate(() => {
            const dt = new DataTransfer();
            dt.setData("text/plain", "dropped text");
            const el = document.querySelector(".ProseMirror p");
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new DragEvent("drop", {
                dataTransfer: dt, bubbles: true, cancelable: true,
                clientX: r.x + 5, clientY: r.y + 5,
            }));
        });
    });

    // ── Layer 2 on its own ──────────────────────────────────────────────────
    // Every gesture above is refused by `editable` (layer 1) or the command
    // gate (layer 3) before the transaction filter ever sees it, so none of
    // them discriminates layer 2: delete the filter and they all still pass.
    // `__testInsertText` dispatches a real doc-changing transaction straight
    // on the view, past both, so this is the one check the filter alone
    // answers. The editable control for it is at the end of the sweep.
    await assertInert(page, check, "a transaction dispatched straight on the view", async () => {
        await page.evaluate(() =>
            window.postMessage({ type: "__testInsertText", text: "FILTERED" }, "*"));
    });

    // ── Chrome clicks ───────────────────────────────────────────────────────
    // The checkbox is a `::before` pseudo on the task item, at its left edge
    // (there is no <input>), so the click lands where the box is painted;
    // `taskCheckbox` returns the point the editable control uses too.
    await assertInert(page, check, "clicking a task checkbox", async () => {
        const pt = await taskCheckbox(page);
        check("read-only: the task checkbox is on the page to click", pt !== null);
        if (pt) { await page.mouse.click(pt.x, pt.y); }
    });

    // Typing into a callout title. That span sets `contentEditable` on itself,
    // so it is the one editable region ProseMirror's own `editable` predicate
    // does not reach — the reason this check exists rather than being folded
    // into the typing check above.
    await assertInert(page, check, "typing in a callout title", async () => {
        const hit = await clickIfPresent(page, ".callout-title-text");
        if (hit) { await page.keyboard.type("EDITED"); }
        // Blur, since these panels commit on blur rather than per keystroke.
        await page.click(".ProseMirror h1");
    });

    // ── Every mutating command, driven through the real message path ────────
    // This is the enumeration the mode's promise rests on: the classification
    // in webview/readOnly.ts is exhaustive over EditorCommandId by type, and
    // this drives every entry marked `mutates` rather than a sample of them.
    const commandResult = await page.evaluate(async (ids) => {
        const before = document.querySelector(".ProseMirror").innerText;
        for (const id of ids) {
            window.postMessage({ type: "editorCommand", command: id }, "*");
        }
        await new Promise((r) => setTimeout(r, 900));
        return {
            changed: document.querySelector(".ProseMirror").innerText !== before,
            writes: window.__posted.filter((m) =>
                ["update", "flushResult", "frontmatterUpdate", "uploadImage"].includes(m.type)).length,
        };
    }, MUTATING_COMMANDS);
    check(
        `read-only: none of the ${MUTATING_COMMANDS.length} mutating commands changes the document`,
        commandResult.changed === false && commandResult.writes === 0,
        `changed=${commandResult.changed} writes=${commandResult.writes}`,
    );

    // ── Reading affordances still work ──────────────────────────────────────
    const selection = await page.evaluate(() => {
        const p = document.querySelector(".ProseMirror p");
        const range = document.createRange();
        range.selectNodeContents(p);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return String(sel).length;
    });
    check("read-only: text is selectable", selection > 0, `selected ${selection} chars`);

    const scrolled = await page.evaluate(() => {
        window.scrollTo(0, 50);
        return window.scrollY;
    });
    check("read-only: the document scrolls", scrolled >= 0);

    // Folding is plugin state, never a doc change, so it must survive the lock.
    // Driven as the real command, which is also a check that a `reads`
    // classification actually reaches its command rather than being refused.
    const foldedBefore = await docText(page);
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "foldAll" }, "*"));
    await page.waitForTimeout(400);
    const foldedAfter = await docText(page);
    const foldWrites = await writeCount(page);
    check(
        "read-only: Fold All still folds, and writes nothing",
        foldedAfter !== foldedBefore && foldWrites === 0,
        `folded=${foldedAfter !== foldedBefore} writes=${foldWrites}`,
    );
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "unfoldAll" }, "*"));
    await page.waitForTimeout(400);

    // Find is the reading half of find-and-replace, so it opens; Replace is
    // the mutating half and is refused. Both are ticket requirements, and both
    // are driven rather than reasoned about.
    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "openFind" }, "*"));
    await page.waitForTimeout(400);
    const findOpen = await page.$(".find-bar");
    check("read-only: Find still opens", findOpen !== null);

    await page.evaluate(() => window.postMessage({ type: "editorCommand", command: "openFindReplace" }, "*"));
    await page.waitForTimeout(300);
    const replaceShown = await page.$eval(
        ".find-bar",
        (el) => el.classList.contains("find-bar--replace-visible"),
    ).catch(() => false);
    check("read-only: Replace does not open", replaceShown === false);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // A code block's Copy button is a reading affordance and must survive.
    // The control column attaches on first reveal, so hover the block first.
    const codePt = await page.$eval(".code-block-wrapper", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + 20 };
    }).catch(() => null);
    if (codePt) { await page.mouse.move(codePt.x, codePt.y); await page.waitForTimeout(250); }
    const copyBtn = await page.$(".copy-btn");
    check("read-only: the code block keeps its Copy button", copyBtn !== null);

    // Link hover popup: navigation is reading, so the popup appears, with
    // Open and Copy and without the verbs that would rewrite the link.
    const linkBox = await page.$eval(".ProseMirror a", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (linkBox) {
        await page.mouse.move(linkBox.x, linkBox.y);
        await page.waitForTimeout(600);
        const popup = await page.evaluate(() => {
            const root = document.querySelector(".lp-root");
            if (!root || getComputedStyle(root).display === "none") { return null; }
            const shown = (sel) => {
                const el = root.querySelector(sel);
                return !!el && getComputedStyle(el).display !== "none";
            };
            return { open: shown(".lp-btn-open"), copy: shown(".lp-btn-copy"),
                edit: shown(".lp-btn-edit"), remove: shown(".lp-btn-remove") };
        });
        check("read-only: the link popup still appears on hover", popup !== null);
        check("read-only: the link popup offers Open and Copy and hides Edit and Remove",
            !!popup && popup.open && popup.copy && !popup.edit && !popup.remove, JSON.stringify(popup));
        await page.mouse.move(5, 5);
        await page.waitForTimeout(300);
    } else {
        check("read-only: the link popup still appears on hover", false, "no link found in the fixture");
    }

    // ── Editing chrome is retired, not merely inert ─────────────────────────
    // A control that looks live and does nothing is the failure the mode's
    // trust argument rests on avoiding, so the chrome that only writes must be
    // off the page, hovered or not. Each is measured hovered, since most of it
    // is invisible at rest in BOTH modes.
    const chrome = await readOnlyChrome(page);
    check("read-only: no block grab handle shows, even hovered",
        chrome.handles === 0, `${chrome.handles} visible markers`);
    check("read-only: the table shows no grips or insert bars",
        chrome.tableOverlay === false, JSON.stringify(chrome));
    check("read-only: the image caption and title fields are read-only inputs",
        chrome.imageInputsReadOnly === true, JSON.stringify(chrome));
    check("read-only: the image path chip has no pencil",
        chrome.imagePencil === false, JSON.stringify(chrome));
    check("read-only: the HTML block offers no Edit Source button",
        chrome.htmlEdit === false, JSON.stringify(chrome));

    // Openers that would show a menu the filter then refuses stay shut.
    await clickIfPresent(page, ".lang-picker-btn");
    await page.waitForTimeout(150);
    const langOpen = await page.evaluate(() => {
        const dd = document.querySelector(".lang-picker-dropdown");
        return !!dd && getComputedStyle(dd).display !== "none";
    });
    check("read-only: the code block language picker does not open", langOpen === false);

    await clickIfPresent(page, ".callout-kind");
    await page.waitForTimeout(150);
    const kindOpen = await page.$(".callout-menu");
    check("read-only: the callout kind picker does not open", kindOpen === null);

    await clickIfPresent(page, ".html-inline");
    await page.waitForTimeout(150);
    const htmlPanel = await page.$(".html-src-panel");
    check("read-only: clicking an HTML block does not open its source", htmlPanel === null);
    await page.click(".ProseMirror h1");

    // ── The fullscreen code editor ──────────────────────────────────────────
    // A code block's fullscreen surface holds a real `<textarea>`, which the
    // ProseMirror `editable` flag cannot reach and the transaction filter only
    // catches on COMMIT. Left alone it accepts typing and then silently drops
    // it, which is the one failure mode worse than a dead button: the user
    // watches their text appear and it never lands. Found at the seam, because
    // the diagram lightbox shares this surface with the code one.
    const fsBefore = await docText(page);
    const opened = await page.evaluate(() => {
        const wrapper = document.querySelector(".code-block-wrapper");
        const btn = wrapper?.querySelector(".code-fullscreen-btn, [class*='fullscreen']");
        btn?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        return !!document.querySelector(".code-lightbox-textarea");
    });
    if (opened) {
        const ta = await page.evaluate(() => {
            const t = document.querySelector(".code-lightbox-textarea");
            return { readOnly: t.readOnly, before: t.value };
        });
        check(
            "read-only: the fullscreen code editor refuses typing rather than discarding it",
            ta.readOnly === true,
            JSON.stringify(ta),
        );
        await page.evaluate(() => {
            document.querySelector(".fs-close, [class*='close']")
                ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(200);
        check(
            "read-only: opening the fullscreen editor changed nothing",
            (await docText(page)) === fsBefore,
        );
    } else {
        check(
            "read-only: the fullscreen code editor refuses typing rather than discarding it",
            false,
            "could not open the fullscreen editor to test it",
        );
    }

    // ── The whole session wrote nothing ─────────────────────────────────────
    const totalWrites = await writeCount(page);
    check(
        "read-only: the whole gesture sweep wrote nothing to the extension",
        totalWrites === 0,
        `writes=${totalWrites}`,
    );

    // ── Rendering identity: read-only vs editable ───────────────────────────
    // Same bytes, same everything except the mode. Structure first (a blocked
    // normalization transaction shows up here), then geometry (the ticket's
    // hard constraint: nothing may move when toggling).
    const shape = (p) => p.evaluate(() => {
        const root = document.querySelector(".ProseMirror");
        // Chrome that only exists to edit is allowed to differ, and does; the
        // constraint is about the DOCUMENT's rendering, so compare the block
        // structure and the text, which is what a reader sees.
        const blocks = [...root.children].map((el) => `${el.tagName}:${el.className}`);
        const rects = [...root.children].map((el) => {
            const r = el.getBoundingClientRect();
            // Relative to the root, so a differing scroll offset cannot make
            // two identical layouts read as different.
            const rr = root.getBoundingClientRect();
            return `${Math.round(r.x - rr.x)},${Math.round(r.y - rr.y)},${Math.round(r.width)},${Math.round(r.height)}`;
        });
        // Gutter chrome (the fold markers) is retired in read-only and is
        // not document text, so it is dropped before the text is compared;
        // `textContent` on the clone, since a detached node has no layout
        // for `innerText` to read.
        const clone = root.cloneNode(true);
        for (const g of clone.querySelectorAll(".heading-fold-gutter")) { g.remove(); }
        return { blocks, rects, text: clone.textContent };
    });

    // Measured on a FRESH read-only load, not on the page the gesture sweep
    // above just finished with. That page has been clicked into, folded and
    // unfolded, so it carries selection-derived chrome (`bc-active` and the
    // like) the editable load has never had a chance to acquire — and a
    // comparison whose two sides were prepared differently would be reporting
    // the difference in preparation, in whichever direction the classes
    // happened to fall.
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".ProseMirror", { timeout: 20000 });
    await page.waitForTimeout(700);
    const readOnlyShape = await shape(page);

    await page.goto(`${baseUrl}/index.html?editable=1`);
    await page.waitForSelector(".ProseMirror", { timeout: 20000 });
    await page.waitForTimeout(700);

    const editableCe = await page.$eval(".ProseMirror", (el) => el.getAttribute("contenteditable"));
    check("editable: the editor IS contenteditable", editableCe === "true", String(editableCe));

    const editableShape = await shape(page);

    check(
        "identical rendering: same block structure in both modes",
        JSON.stringify(readOnlyShape.blocks) === JSON.stringify(editableShape.blocks),
        `read-only ${readOnlyShape.blocks.length} blocks, editable ${editableShape.blocks.length}`,
    );
    check(
        "identical rendering: same text in both modes",
        readOnlyShape.text === editableShape.text,
    );
    const movedBlocks = readOnlyShape.rects
        .map((r, i) => (r === editableShape.rects[i] ? null : `${readOnlyShape.blocks[i]} ${r} vs ${editableShape.rects[i]}`))
        .filter(Boolean);
    check(
        "identical rendering: no block moves between modes",
        movedBlocks.length === 0,
        movedBlocks.slice(0, 3).join(" | "),
    );

    // The control for every check above: the same typing gesture that was a
    // no-op in read-only MUST change the document here. Without this the whole
    // suite would pass against an editor that was simply broken.
    await page.click(".ProseMirror p");
    const editableBefore = await docText(page);
    await page.keyboard.type("XYZZY");
    await page.waitForTimeout(400);
    const editableAfter = await docText(page);
    const editableWrites = await writeCount(page);
    check(
        "control: the same typing DOES change the document when editable",
        editableAfter !== editableBefore && editableWrites > 0,
        `changed=${editableAfter !== editableBefore} writes=${editableWrites}`,
    );

    // The same three controls for the read-only checks that had no typing
    // analogue: the direct dispatch (layer 2's discriminator), the checkbox
    // click, and the chrome that must come BACK when the mode is off.
    const directBefore = await docText(page);
    await page.evaluate(() =>
        window.postMessage({ type: "__testInsertText", text: "FILTERED" }, "*"));
    await page.waitForTimeout(200);
    check("control: a transaction dispatched straight on the view lands when editable",
        (await docText(page)).includes("FILTERED"), "text did not land");

    const checkboxPt = await taskCheckbox(page);
    const checkedBefore = await taskChecked(page);
    if (checkboxPt) { await page.mouse.click(checkboxPt.x, checkboxPt.y); }
    await page.waitForTimeout(200);
    const checkedAfter = await taskChecked(page);
    check("control: the same checkbox click DOES flip the task when editable",
        checkboxPt !== null && checkedBefore !== null && checkedBefore !== checkedAfter,
        `${checkedBefore} -> ${checkedAfter}`);
    void directBefore;

    const editableChrome = await readOnlyChrome(page);
    check("control: the editing chrome is on the page when editable",
        editableChrome.handles > 0 && editableChrome.tableOverlay && editableChrome.imagePencil
            && editableChrome.htmlEdit && editableChrome.imageInputsReadOnly === false,
        JSON.stringify(editableChrome));

    // ── The toolbar toggle, driven as a real click ──────────────────────────
    // Still on the editable load, so this exercises the direction a user
    // actually takes first: lock a document they are reading.
    const toggleSel = '[data-item-id="readOnly"] button';
    const hasToggle = await page.$(toggleSel);
    // The item ships hidden; the harness places it, so this measures the
    // wiring of a toggle a user has chosen to show, not the default bar.
    check("the toolbar carries the Edit / Read-only toggle when its item is placed", hasToggle !== null);

    // Clicked in-page rather than through page.mouse. The bar overflows into a
    // menu at narrow widths and this harness viewport is one of them, so a
    // coordinate click would be measuring the overflow layout instead of the
    // toggle. The dispatched click is still a real DOM event reaching the real
    // listener, which is the wiring under test here; the bar's own placement
    // belongs to the toolbar suites.
    const clickToggle = () => page.$eval(toggleSel, (el) => el.click());

    if (hasToggle) {
        await clickToggle();
        await page.waitForTimeout(200);
        const locked = await page.evaluate((sel) => ({
            body: document.body.classList.contains("read-only"),
            editable: document.querySelector(".ProseMirror").getAttribute("contenteditable"),
            pressed: document.querySelector(sel).getAttribute("aria-pressed"),
            boldDisabled: document.querySelector('[data-item-id="bold"] button')?.disabled ?? null,
        }), toggleSel);
        check(
            "the toggle locks the editor live, with no reload",
            locked.body === true && locked.editable === "false" && locked.pressed === "true",
            JSON.stringify(locked),
        );
        check(
            "locking disables the formatting buttons",
            locked.boldDisabled === true,
            String(locked.boldDisabled),
        );

        // The lock is live, so a keystroke after the toggle must be refused by
        // the very same editor that accepted one a moment ago. This is the
        // check that the `editable` predicate is re-read on toggle rather than
        // baked in at mount.
        // The caret goes into a paragraph BEFORE the measurement: the image
        // the controls above selected carries chrome whose text leaves the
        // DOM on deselect, and that is not an edit.
        await page.click(".ProseMirror p");
        await page.waitForTimeout(100);
        await assertInert(page, check, "typing after toggling the lock on", async () => {
            await page.keyboard.type("NOPE");
        });

        // ...and back, so the toggle is proven in both directions rather than
        // as a one-way trip.
        await clickToggle();
        await page.waitForTimeout(200);
        const unlockedBefore = await docText(page);
        await page.click(".ProseMirror p");
        await page.keyboard.type("AGAIN");
        await page.waitForTimeout(400);
        check(
            "the toggle unlocks the editor again",
            (await docText(page)) !== unlockedBefore,
        );

        // Locking must never STRAND an edit. The sync scheduler debounces, so
        // an edit made and then locked inside that window has been typed but
        // not yet posted, and a lock that also stopped the pending sync would
        // silently drop it. Typed and locked with no wait between, which is
        // the race a user hits by reaching for the toggle the moment they stop
        // typing.
        await page.click(".ProseMirror p");
        await page.keyboard.type("PENDING");
        await clickToggle();
        await page.waitForTimeout(1500);
        const landed = await page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").some((m) => m.content.includes("PENDING")));
        check(
            "locking does not strand an edit made just before it",
            landed === true,
            landed ? "" : "the pending sync never posted the typed text",
        );
    }
}

/** The painted checkbox of the first task item: a point to click, or null. */
function taskCheckbox(page) {
    return page.$eval('li[data-item-type="task"]', (li) => {
        const r = li.getBoundingClientRect();
        // The box is a 14px `::before` at the item's left edge; aim at its
        // centre, and vertically at the first text line.
        return { x: r.x + 7, y: r.y + 10 };
    }).catch(() => null);
}

/** The first task item's checked bit as the DOM has it, or null. */
function taskChecked(page) {
    return page.$eval('li[data-item-type="task"]', (li) =>
        li.getAttribute("data-checked") === "true").catch(() => null);
}

/**
 * The editing chrome the mode retires, measured HOVERED where it hides at
 * rest. Each field is what a reader would see; the read-only pass asserts the
 * chrome is gone and the editable pass asserts the same chrome is there, so a
 * selector that has drifted fails the control rather than passing both.
 */
async function readOnlyChrome(page) {
    // Hover `hoverSel`, then read `probe` in the page while it is hovered.
    // The probe gets a `visible(el)` helper: painted, and not display/visibility
    // hidden.
    const hoverAndRead = async (hoverSel, probe) => {
        const box = await page.$eval(hoverSel, (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + Math.min(20, r.width / 2), y: r.y + Math.min(10, r.height / 2) };
        }).catch(() => null);
        if (!box) { return null; }
        await page.mouse.move(box.x, box.y);
        await page.waitForTimeout(250);
        return page.evaluate((src) => {
            const visible = (el) => {
                if (!el) { return false; }
                const s = getComputedStyle(el);
                if (s.display === "none" || s.visibility === "hidden") { return false; }
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            };
            return new Function("visible", `return (${src})(visible);`)(visible);
        }, probe.toString());
    };
    const handles = await hoverAndRead(".ProseMirror > p", (visible) =>
        [...document.querySelectorAll(".heading-fold-marker")].filter(visible).length);
    const tableOverlay = await hoverAndRead(".mw-table", (visible) =>
        visible(document.querySelector(".mw-table-overlay")));
    // The image toolbar (path chip, title) shows for a SELECTED image, so
    // click it rather than hover; a NodeSelection is reading in both modes.
    const imgPt = await page.$eval(".image-wrapper img.image-node", (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }).catch(() => null);
    if (imgPt) { await page.mouse.click(imgPt.x, imgPt.y); await page.waitForTimeout(250); }
    const image = await hoverAndRead(".image-wrapper", (visible) => {
        const w = document.querySelector(".image-wrapper");
        const caption = w?.querySelector(".image-caption");
        const title = w?.querySelector(".img-tb-title");
        return {
            inputsReadOnly: !!caption && !!title && caption.readOnly && title.readOnly,
            pencil: visible(w?.querySelector(".img-tb-path-pencil")),
        };
    });
    const htmlEdit = await hoverAndRead(".html-inline", (visible) =>
        visible(document.querySelector(".html-edit-btn")));
    await page.mouse.move(5, 5);
    return {
        handles: handles ?? -1,
        tableOverlay: tableOverlay ?? null,
        imageInputsReadOnly: image?.inputsReadOnly ?? null,
        imagePencil: image?.pencil ?? null,
        htmlEdit: htmlEdit ?? null,
    };
}

/**
 * Every command classified `mutates` in webview/readOnly.ts. Duplicated here
 * rather than imported because a checks.mjs runs in Node against the built
 * bundle and cannot import the TypeScript source; `webview/__tests__/readOnly
 * .test.ts` asserts this list matches the classification exactly, so the two
 * cannot drift silently.
 */
const MUTATING_COMMANDS = [
    "toggleBold", "toggleItalic", "toggleStrikethrough", "toggleHighlight",
    "toggleInlineCode", "clearFormatting", "setParagraph", "setHeading1",
    "setHeading2", "setHeading3", "setHeading4", "setHeading5", "setHeading6",
    "toggleBulletList", "toggleOrderedList", "toggleTaskList", "toggleTaskChecked", "toggleBlockquote",
    "insertCodeBlock", "insertHorizontalRule", "insertTable", "insertLink",
    "insertSectionLink", "insertImage", "insertMath", "insertFootnote",
    "insertCallout", "toggleCallout", "insertParagraphAfter", "insertParagraphBefore",
    "duplicateBlockUp", "duplicateBlockDown", "moveBlockUp", "moveBlockDown",
    "indentBlock", "outdentBlock", "deleteBlock", "joinLines",
    "transformToUppercase", "transformToLowercase", "transformToTitleCase",
    "uncheckAllTasks", "pasteAsPlainText",
    "tableInsertRowAbove", "tableInsertRowBelow", "tableInsertColumnLeft",
    "tableInsertColumnRight", "tableAlignColumnLeft", "tableAlignColumnCenter",
    "tableAlignColumnRight", "tableDeleteRow", "tableDeleteColumn", "tableDeleteTable",
    "editBlockSource", "editFrontmatter", "openFindReplace",
    "selectAllOccurrences",
];
