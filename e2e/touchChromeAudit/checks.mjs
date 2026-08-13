/**
 * Every piece of interactive chrome that lives INSIDE the contentEditable root,
 * audited against the defect MAR-340 found on the table overlay: Blink hands a
 * finger's contact to the editable text beside the chrome unless the chrome
 * declares itself non-editable. A mouse retargets nothing, so the whole class
 * is invisible to mouse testing and to jsdom, and this suite is the only place
 * it can be seen.
 *
 * Two axes, because neither one alone covers the class.
 *
 *   1. An ATTRIBUTE sweep over the rendered DOM: every button, and everything
 *      with an interactive cursor and live pointer events, inside .ProseMirror.
 *      It reports what is editable and what is not.
 *   2. BEHAVIOUR: a real touch, driven through Blink's own gesture recognizer,
 *      at a representative of each distinct overlay, asserting the contact
 *      lands on that chrome rather than on the text beside it.
 *
 * The blind spot is named here because it is the thing that made the audit
 * nearly miss its most interesting case: an attribute sweep can only see
 * chrome that HAS a DOM node. The task-list checkbox is a `::before`
 * pseudo-element on an ordinary editable `<li>`, hit-tested on pure geometry
 * by a document-level click listener, so there is no element for it to find
 * and nothing that could carry the attribute. It is covered by behaviour
 * instead, at the end of this file, and that check is the reason the blind
 * spot is not merely acknowledged.
 */

/** Constructs whose chrome this audit is about. All must render, or the sweep
 *  is measuring an empty document and would pass by reaching nothing. */
const CONSTRUCTS = [
    "table", "codeBlock", "mermaid", "calc", "image", "callout", "directive",
    "footnote", "math", "wikiLink", "html", "headingFold", "list", "task",
];

/**
 * The only interactive things inside .ProseMirror that are editable ON
 * PURPOSE. `.wiki-link-src` is the wiki_link NodeView's contentDOM, which is
 * what makes a wikilink's source editable character by character; its `<a>`
 * parent is therefore editable too. Declaring either non-editable would break
 * that feature, so this is an exemption with a reason, not a tolerated leak.
 */
const EDITABLE_BY_DESIGN = ["a.wiki-link", "span.wiki-link-src"];

/**
 * Chrome protected ONLY by prosemirror-view's implicit stamp, never by this
 * repo's own code: a NodeView with no contentDOM, and a Decoration.widget
 * without `raw: true`, both get contentEditable="false" from PM itself.
 * Asserted as the runtime property rather than by re-deriving PM's rule, so
 * this goes red if a refactor gives one of them a contentDOM or pre-sets a
 * contenteditable attribute, which is exactly what would remove the stamp.
 */
const IMPLICIT_ONLY = [
    ".image-wrapper",
    ".image-wrapper input.image-caption",
    "sup.footnote-ref",
    "span.html-inline",
];

/** A floor, so a sweep that reached almost nothing cannot read as a clean one. */
const MIN_CHROME_KINDS = 60;

/**
 * Chrome this fixture cannot bring on screen, each with the reason it is
 * absent rather than broken. Listed so the count below is checkable and a
 * future run that silently stops reaching things fails instead of passing.
 */
const KNOWN_UNREACHED = {
    "mermaid pan button":
        "the pan pad is drawn only where the content actually pans " +
        "(docs/DESIGN_PRINCIPLES.md, fullscreen geography); a two-node graph does not",
};

async function touchOn(page) {
    const cdp = await page.context().newCDPSession(page);
    const enable = async () => {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        await cdp.send("Emulation.setEmulatedMedia", {
            features: [
                { name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" },
                { name: "hover", value: "none" }, { name: "any-hover", value: "none" },
            ],
        });
    };
    const disable = async () => {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    };
    const tap = async (x, y, id = 7) => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id }] });
        await page.waitForTimeout(60);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(160);
    };
    return { enable, disable, tap };
}

/** Hover every block and its gutter: chrome that is never built cannot be audited. */
async function revealEverything(page) {
    const blocks = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror > *")].map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + Math.min(40, r.width / 2), y: r.y + Math.min(20, r.height / 2), left: r.x };
        }));
    for (const b of blocks) {
        await page.mouse.move(b.left - 10, b.y);
        await page.mouse.move(b.x, b.y);
        await page.waitForTimeout(40);
    }
    const cell = await page.evaluate(() => {
        const c = document.querySelector(".ProseMirror table td");
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (cell) { await page.mouse.click(cell.x, cell.y); await page.waitForTimeout(150); }
}

const sweep = (page) => page.evaluate(() => {
    const root = document.querySelector(".ProseMirror");
    if (!root) return { rows: [], error: "no .ProseMirror" };
    const INTERACTIVE = new Set(["pointer", "grab", "grabbing", "col-resize", "row-resize", "ew-resize", "ns-resize", "move"]);
    const rows = [];
    const seen = new Set();
    for (const el of root.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (el.tagName !== "BUTTON" && !INTERACTIVE.has(cs.cursor)) continue;
        if (cs.pointerEvents === "none") continue;
        const cls = String(el.className?.baseVal ?? el.className ?? "").trim();
        const key = `${el.tagName.toLowerCase()}.${cls.split(" ")[0]}|${el.isContentEditable}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
            sel: `${el.tagName.toLowerCase()}.${cls.split(" ")[0]}`,
            editable: el.isContentEditable,
        });
    }
    return { rows };
});

export async function run({ page, check, baseUrl }) {
    const touch = await touchOn(page);
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
    await page.waitForTimeout(2500); // lazy panes (mermaid, katex) settle

    // ── 1. Coverage of the document itself. Everything below is an audit OF
    //       these constructs, so a missing one silently shrinks the audit.
    const present = await page.evaluate(() => ({
        table: !!document.querySelector(".ProseMirror table"),
        codeBlock: !!document.querySelector(".ProseMirror .code-block-wrapper"),
        mermaid: !!document.querySelector(".ProseMirror .mermaid-preview"),
        calc: !!document.querySelector(".ProseMirror .calc-preview"),
        image: !!document.querySelector(".ProseMirror .image-wrapper"),
        callout: !!document.querySelector(".ProseMirror .callout-title"),
        directive: !!document.querySelector(".ProseMirror .directive-header"),
        footnote: !!document.querySelector(".ProseMirror .footnote-def-marker"),
        math: !!document.querySelector(".ProseMirror .math-inline-render"),
        wikiLink: !!document.querySelector(".ProseMirror .wiki-link"),
        html: !!document.querySelector(".ProseMirror .html-inline"),
        headingFold: !!document.querySelector(".ProseMirror .heading-fold-marker"),
        list: !!document.querySelector(".ProseMirror ul li"),
        task: !!document.querySelector('.ProseMirror li[data-item-type="task"]'),
    }));
    const missing = CONSTRUCTS.filter((c) => !present[c]);
    check("every construct this audit covers actually rendered",
        missing.length === 0, `missing: ${missing.join(", ") || "none"}`);

    await revealEverything(page);
    await page.waitForTimeout(400);

    // ── 2. The attribute sweep, with both counts asserted.
    const { rows } = await sweep(page);
    const editable = rows.filter((r) => r.editable).map((r) => r.sel).sort();
    const declared = rows.filter((r) => !r.editable);
    check("the sweep reached a substantial amount of chrome",
        rows.length >= MIN_CHROME_KINDS, `${rows.length} kinds, floor ${MIN_CHROME_KINDS}`);
    check("all interactive chrome declares itself non-editable, bar the wikilink's own source",
        JSON.stringify(editable) === JSON.stringify([...EDITABLE_BY_DESIGN].sort()),
        JSON.stringify(editable));
    check("the declared and editable counts account for the whole sweep",
        declared.length + editable.length === rows.length,
        `${declared.length} declared + ${editable.length} editable = ${rows.length}`);

    // ── 3. The chrome that only prosemirror-view's implicit stamp protects.
    const implicit = await page.evaluate((sels) => sels.map((s) => {
        const el = document.querySelector(`.ProseMirror ${s}`);
        return { s, found: !!el, editable: el ? el.isContentEditable : null };
    }), IMPLICIT_ONLY);
    check("chrome relying on ProseMirror's implicit stamp is still non-editable",
        implicit.every((r) => r.found && r.editable === false), JSON.stringify(implicit));

    // ── 4. Behaviour: does a real touch land on the chrome, or on the text?
    await touch.enable();
    const tapTarget = async (x, y) => {
        await page.evaluate(() => {
            window.__tt = null;
            document.addEventListener("pointerdown", (e) => {
                const el = e.target;
                window.__tt = el instanceof Element
                    ? {
                        tag: el.tagName.toLowerCase(),
                        cls: String(el.className?.baseVal ?? el.className ?? "").split(" ")[0],
                        root: el.classList?.contains("ProseMirror") ?? false,
                    }
                    : { tag: "?", cls: "", root: false };
            }, { once: true, capture: true });
        });
        await touch.tap(x, y);
        return page.evaluate(() => window.__tt);
    };
    /**
     * A contact that was handed to the document's text lands on one of the
     * editable containers, or on the editor root itself.
     *
     * Matched on the tag EXACTLY. An earlier version tested the rendered
     * "tag.class" string against an alternation containing `li`, which also
     * matched the leading two characters of `line.` — the SVG line inside the
     * table's "+" button — and reported a correct landing as a retarget.
     */
    const EDITABLE_HOSTS = new Set(["td", "th", "p", "li", "html", "body"]);
    const isRetargeted = (t) => !t || t.root || EDITABLE_HOSTS.has(t.tag);
    const show = (t) => (t ? `${t.tag}.${t.cls}` : "nothing");
    // `reveal` is [selector, "hover"|"click"] where chrome appears only once
    // its block has been reached.
    const SUBJECTS = [
        ["table row grip", ".mw-grip--row", [".ProseMirror table td", "hover"]],
        ["table insert +", ".mw-insert-btn", [".ProseMirror table td", "hover"]],
        ["heading fold marker", ".heading-fold-marker", null],
        ["code block lang picker", ".lang-picker-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block resize handle", ".code-block-resize-handle", null],
        ["callout kind button", ".callout-kind", null],
        ["block width control", ".bc-btn", null],
        ["mermaid pan button", ".mermaid-pan-btn", [".ProseMirror .mermaid-preview", "hover"]],
        ["image toolbar button", ".img-tb-btn", [".ProseMirror .image-wrapper img", "click"]],
        ["footnote backlink", ".footnote-def-backlink", null],
        ["footnote ref", ".footnote-ref", null],
        ["wiki link", ".wiki-link", null],
        ["regular link", ".ProseMirror a:not(.wiki-link)", null],
    ];
    const centre = (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return { zero: true };
        return {
            x: r.x + r.width / 2, y: r.y + r.height / 2,
            inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        };
    }, sel.startsWith(".ProseMirror") ? sel : `.ProseMirror ${sel}`);

    const landed = [];
    const retargeted = [];
    const unreached = [];
    for (const [name, sel, reveal] of SUBJECTS) {
        await page.keyboard.press("Escape"); // drop anything a previous subject opened
        await page.waitForTimeout(120);
        if (reveal) {
            const [hostSel, how] = reveal;
            const h = await centre(hostSel);
            if (h && !h.zero) {
                await page.mouse.move(h.x - 30, h.y);
                await page.mouse.move(h.x, h.y);
                if (how === "click") { await page.mouse.click(h.x, h.y); }
                await page.waitForTimeout(250);
            }
        }
        const box = await centre(sel);
        if (!box) { unreached.push([name, "not in the DOM"]); continue; }
        if (box.zero) { unreached.push([name, "rendered with a zero-sized box"]); continue; }
        await page.waitForTimeout(120);
        const box2 = await centre(sel);
        if (!box2 || box2.zero) { unreached.push([name, "lost its box after scrolling"]); continue; }
        if (!box2.inView) { unreached.push([name, "could not be brought into the viewport"]); continue; }
        const got = await tapTarget(box2.x, box2.y);
        (isRetargeted(got) ? retargeted : landed).push(`${name} -> ${show(got)}`);
    }
    check("a finger's contact lands on the chrome it was aimed at, never the text beside it",
        retargeted.length === 0, `retargeted: ${JSON.stringify(retargeted)}`);
    check("the touch sweep drove the subjects it claims to have driven",
        landed.length + retargeted.length + unreached.length === SUBJECTS.length &&
        landed.length + retargeted.length >= 12,
        `${landed.length} landed, ${retargeted.length} retargeted, ${unreached.length} unreached, ` +
        `${SUBJECTS.length} total: ${JSON.stringify(landed)}`);
    const unexpected = unreached.filter(([n]) => !(n in KNOWN_UNREACHED));
    check("every unreached subject is one this fixture is known not to render",
        unexpected.length === 0, JSON.stringify(unreached));

    // ── 5. The blind spot, closed by behaviour. The task checkbox is a
    //       `::before` on an editable <li>, toggled by a document-level click
    //       listener that requires clientX inside a 24px column measured from
    //       the item's left edge (webview/utils/taskCheckbox.ts). Blink's
    //       touch adjustment MOVES the coordinates of the click it synthesizes
    //       from a tap, so this is the one place the class could bite with no
    //       element anywhere to carry contentEditable. The arriving clientX is
    //       reported either way: a pass with no margin is worth seeing.
    await page.keyboard.press("Escape");
    // Two task items, because a checkbox TOGGLES: the mouse control below must
    // tick its own, or it clicks the one the finger just ticked and reads the
    // untick as a failure to act.
    const taskAt = (i) => page.evaluate((n) => {
        const li = document.querySelectorAll('.ProseMirror li[data-item-type="task"]')[n];
        if (!li) return null;
        li.scrollIntoView({ block: "center" });
        const r = li.getBoundingClientRect();
        return { left: r.left, y: r.y + Math.min(12, r.height / 2) };
    }, i);
    const task = await taskAt(0);
    check("the task item is on screen to be tapped", task !== null, JSON.stringify(task));
    if (task) {
        const AIM = 12; // middle of the 24px checkbox column
        // The li's left edge is captured BEFORE the tap: the toggle re-renders
        // the list, so a rect read inside the listener measures the wrong box.
        const instrument = async (left) => page.evaluate((l) => {
            window.__clicks = [];
            window.__liLeft = l;
            document.addEventListener("click", (e) => window.__clicks.push({
                clientX: Math.round(e.clientX),
                offsetX: Math.round(e.clientX - window.__liLeft),
            }), true);
        }, left);
        const docNow = () => page.evaluate(() =>
            window.__posted.filter((m) => m.type === "update").map((m) => m.content).pop() ?? null);
        const checked = (d) => (String(d).match(/- \[x\]/g) ?? []).length;

        await instrument(task.left);
        const before = await docNow();
        await touch.tap(task.left + AIM, task.y, 8);
        await page.waitForTimeout(600);
        const touchClicks = await page.evaluate(() => window.__clicks);
        const afterTouch = await docNow();
        check("tapping a task checkbox ticks it",
            checked(afterTouch) === checked(before) + 1,
            `aimed offsetX=${AIM}, arrived ${JSON.stringify(touchClicks)}, ` +
            `checked ${checked(before)} -> ${checked(afterTouch)}`);

        // The control that makes the above evidence: the same aim with a real
        // mouse, on the SECOND item so it is ticking rather than unticking.
        // Without this control a touch failure could be blamed on coordinates.
        await touch.disable();
        const task2 = await taskAt(1);
        await instrument(task2.left);
        const beforeMouse = await docNow();
        await page.mouse.click(task2.left + AIM, task2.y);
        await page.waitForTimeout(600);
        const mouseClicks = await page.evaluate(() => window.__clicks);
        const afterMouse = await docNow();
        check("the same aim with a mouse ticks one too, so the aim is sound",
            checked(afterMouse) === checked(beforeMouse) + 1,
            `arrived ${JSON.stringify(mouseClicks)}, ` +
            `checked ${checked(beforeMouse)} -> ${checked(afterMouse)}`);
    }
}
