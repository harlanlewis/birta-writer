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
 *
 * Both axes are bounded by the same thing: chrome that is never built cannot be
 * audited, and most of this editor's chrome is built on reveal and torn down
 * again. So the attribute sweep runs once per reveal state and unions its
 * passes, and the subject list below carries the gesture each control needs.
 * Where a control ACTS when it is tapped, the subject order is what keeps the
 * next one reachable: the source toggle swaps a diagram for its source, and the
 * fold controls take the rest of the document off screen, so both go last.
 */

/** Constructs whose chrome this audit is about. All must render, or the sweep
 *  is measuring an empty document and would pass by reaching nothing. */
const CONSTRUCTS = [
    "table", "codeBlock", "mermaid", "calc", "image", "callout", "directive",
    "footnote", "math", "wikiLink", "html", "headingFold", "list", "task",
    "blockquote", "orderedList", "rule", "linkDefinition", "imageRef",
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

/**
 * Floors, so a sweep that reached almost nothing cannot read as a clean one.
 * Both are below what the suite currently reaches, with room for the slack a
 * browser engine's own markup introduces; run `node e2e/run.mjs
 * touchChromeAudit` for the live figures rather than trusting a number here.
 *
 * The kinds floor was 35, against a population keyed on each element's FIRST
 * class. That is a chrome primitive on many of these controls (`ui-btn`,
 * `bc-btn`), so the code block's whole rail was one kind, the mermaid pan pad
 * and its zoom overlay were another, and one representative of each was what
 * got audited. Keying on the element's own class is what the two floors are
 * now set against.
 */
const MIN_CHROME_KINDS = 50;
const MIN_TOUCHED_SUBJECTS = 25;

/**
 * Chrome this fixture cannot bring on screen, each with the reason it is
 * absent rather than broken. Empty: every subject below is currently reached,
 * so an unreached one is a finding rather than a footnote.
 */
const KNOWN_UNREACHED = {};

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

/**
 * One pass of the attribute sweep over whatever is on screen RIGHT NOW.
 *
 * A single pass can only see chrome that exists at that instant, and much of
 * this editor's chrome is built on reveal and torn down again: a menu closes,
 * a hover ends, a selection moves. The caller therefore runs this repeatedly
 * across reveal states and unions the results (`collector` below), so the
 * population is everything that was ever built rather than everything that
 * survived to the end.
 *
 * A kind is named by its OWN class, not by the first class in the attribute.
 * The chrome primitives (`ui-btn`, `bc-btn`, and the menu-row family) are the
 * first class on many different buttons, so keying on `className.split(" ")[0]`
 * collapsed the code block's five rail buttons, the mermaid pan pad and the
 * zoom controls into two kinds and audited one representative of each.
 */
const PRIMITIVES = new Set([
    "ui-btn", "bc-btn", "ui-menu-row", "ui-heading", "ui-menu-heading", "ui-notice",
]);

const sweepOnce = (page) => page.evaluate((primitives) => {
    const root = document.querySelector(".ProseMirror");
    if (!root) return { rows: [], foreign: [], error: "no .ProseMirror" };
    const INTERACTIVE = new Set(["pointer", "grab", "grabbing", "col-resize", "row-resize", "ew-resize", "ns-resize", "move"]);
    const rows = [];
    const foreign = [];
    for (const el of root.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (el.tagName !== "BUTTON" && !INTERACTIVE.has(cs.cursor)) continue;
        if (cs.pointerEvents === "none") continue;
        const classes = String(el.className?.baseVal ?? el.className ?? "").trim().split(/\s+/).filter(Boolean);
        const own = classes.filter((c) => !primitives.includes(c) && !c.startsWith("ui-btn--"));
        const sel = `${el.tagName.toLowerCase()}.${own[0] ?? classes[0] ?? ""}`;
        // `isContentEditable` is an HTMLElement property. SVG and MathML nodes
        // are Element but not HTMLElement, so it reads `undefined` on every
        // interior node of a rendered mermaid diagram or KaTeX formula. Those
        // used to enter `rows` with no verdict and be counted as compliant,
        // because `!undefined` is true: they inflated the reached count by
        // roughly half and told the editability question nothing.
        //
        // They are not chrome in the sense this audit means. What could be
        // retargeted is a diagram's own container, which IS an HTMLElement and
        // is still swept. Counted separately so the exclusion stays visible.
        if (!(el instanceof HTMLElement)) {
            foreign.push(sel);
            continue;
        }
        rows.push({ sel, editable: el.isContentEditable });
    }
    return { rows, foreign };
}, [...PRIMITIVES]);

/** Unions the passes. Keyed on sel AND verdict, so one kind that is editable in
 *  one state and not in another is two rows and neither hides the other. */
function collector(page) {
    const rows = new Map();
    const foreign = new Set();
    return {
        async take() {
            const pass = await sweepOnce(page);
            for (const r of pass.rows) rows.set(`${r.sel}|${r.editable}`, r);
            for (const f of pass.foreign) foreign.add(f);
            return pass;
        },
        get rows() { return [...rows.values()]; },
        get foreign() { return [...foreign]; },
    };
}

/**
 * Bring chrome on screen, sweeping after every state so nothing that is torn
 * down on the next gesture is missed.
 *
 * Three kinds of reveal, each needed for chrome the others never build:
 *   - hovering every top-level block and its left gutter (the block strip);
 *   - putting the caret in a table cell (the table overlay's grips and bars);
 *   - opening the menus that only exist while open (the callout's kind menu,
 *     the code block's language picker), and selecting the image, whose
 *     toolbar is built by `selectNode`.
 */
async function revealEverything(page, collect) {
    const blocks = await page.evaluate(() =>
        [...document.querySelectorAll(".ProseMirror > *")].map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + Math.min(40, r.width / 2), y: r.y + Math.min(20, r.height / 2), left: r.x };
        }));
    for (const b of blocks) {
        await page.mouse.move(b.left - 10, b.y);
        await page.mouse.move(b.x, b.y);
        await page.waitForTimeout(40);
        await collect.take();
    }
    const cell = await page.evaluate(() => {
        const c = document.querySelector(".ProseMirror table td");
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (cell) { await page.mouse.click(cell.x, cell.y); await page.waitForTimeout(150); await collect.take(); }

    // Chrome that exists only while something is open or selected. Each entry
    // is [what to click first, what that builds INSIDE the root]; the second
    // selector is asserted, so a construct this fixture stops rendering shows
    // up as an unreached reveal rather than as a silently smaller sweep.
    //
    // The code block's language dropdown is deliberately not here: it mounts on
    // `document.body`, outside the contentEditable root, so no contact on it can
    // be retargeted and it is not this audit's subject. Its trigger button is,
    // and the trigger is swept and tapped like the rest of the rail.
    const ON_DEMAND = [
        [".ProseMirror .callout-kind", ".callout-menu"],
        [".ProseMirror .image-wrapper img", ".image-toolbar"],
    ];
    const built = [];
    for (const [trigger, opened] of ON_DEMAND) {
        const box = await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return null;
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        }, trigger);
        if (!box) continue;
        await page.mouse.move(box.x, box.y);
        await page.mouse.click(box.x, box.y);
        await page.waitForTimeout(250);
        await collect.take();
        built.push([opened, await page.evaluate((s) => !!document.querySelector(`.ProseMirror ${s}`), opened)]);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(120);
    }
    return built;
}

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
        blockquote: !!document.querySelector(".ProseMirror blockquote"),
        orderedList: !!document.querySelector(".ProseMirror ol li"),
        rule: !!document.querySelector(".ProseMirror hr"),
        linkDefinition: !!document.querySelector(".ProseMirror .link-definition"),
        imageRef: !!document.querySelector(".ProseMirror .image-ref"),
    }));
    const missing = CONSTRUCTS.filter((c) => !present[c]);
    check("every construct this audit covers actually rendered",
        missing.length === 0, `missing: ${missing.join(", ") || "none"}`);

    const collect = collector(page);
    await collect.take();
    const opened = await revealEverything(page, collect);
    await page.waitForTimeout(400);
    await collect.take();
    check("the on-demand chrome this audit opens actually opened",
        opened.length === 2 && opened.every(([, ok]) => ok), JSON.stringify(opened));

    // ── 2. The attribute sweep, with both counts asserted.
    const rows = collect.rows;
    const foreign = collect.foreign;
    const editable = rows.filter((r) => r.editable).map((r) => r.sel).sort();
    check("the sweep reached a substantial amount of chrome",
        rows.length >= MIN_CHROME_KINDS, `${rows.length} kinds, floor ${MIN_CHROME_KINDS}`);
    check("all interactive chrome declares itself non-editable, bar the wikilink's own source",
        JSON.stringify(editable) === JSON.stringify([...EDITABLE_BY_DESIGN].sort()),
        JSON.stringify(editable));
    // `declared` and `editable` are exact complements of one array, so summing
    // them to `rows.length` is true for any value of `r.editable` and no change
    // to production code can turn it red. What is worth asserting is that every
    // row carried a real verdict: an element the sweep failed to find would
    // arrive with `editable: null`, which is neither, and would otherwise be
    // counted as "declared" and vanish into the pass.
    const undecided = rows.filter((r) => r.editable !== true && r.editable !== false);
    check("every kind the sweep enumerated returned a real verdict",
        undecided.length === 0,
        `${undecided.length} undecided of ${rows.length}: ${JSON.stringify(undecided.map((r) => r.sel))}`);
    // What the sweep deliberately did NOT judge, named rather than dropped, so
    // the reached count above cannot quietly absorb it.
    check("the non-HTML interiors it skipped are reported, not silently dropped",
        Array.isArray(foreign),
        `${foreign.length} SVG/MathML kinds skipped: ${JSON.stringify(foreign.slice(0, 8))}${foreign.length > 8 ? " …" : ""}`);

    // ── 3. The chrome that only prosemirror-view's implicit stamp protects.
    const implicit = await page.evaluate((sels) => sels.map((s) => {
        const el = document.querySelector(`.ProseMirror ${s}`);
        return { s, found: !!el, editable: el ? el.isContentEditable : null };
    }), IMPLICIT_ONLY);
    check("chrome relying on ProseMirror's implicit stamp is still non-editable",
        implicit.every((r) => r.found && r.editable === false), JSON.stringify(implicit));

    // ── 4. Behaviour: does a real touch land on the chrome, or on the text?
    await touch.enable();
    // The task checkbox (section 5, hoisted) runs BEFORE the subject sweep: the
    // sweep's last subjects fold a heading, which takes the task list off
    // screen, and a zero-sized rect there would read as a touch failure.
    await taskCheckboxProbe();
    await touch.enable(); // the probe's mouse control turns emulation off
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
    //
    // Order is load-bearing at the end only: a tap ACTS, so the two fold
    // subjects come last. Folding a heading takes the rest of the document off
    // screen, and a subject after them would be reported unreached for a
    // reason that has nothing to do with touch.
    const SUBJECTS = [
        ["table row grip", ".mw-grip--row", [".ProseMirror table td", "hover"]],
        ["table insert +", ".mw-insert-btn", [".ProseMirror table td", "hover"]],
        ["table width control", ".mw-bc-width", [".ProseMirror table td", "hover"]],
        // Before the code-block rail: the rail's source toggle swaps the
        // mermaid block from its preview to its source, and the pan pad and
        // zoom overlay live on the preview.
        ["mermaid pan button", ".mermaid-pan-btn", [".ProseMirror .mermaid-preview", "hover"]],
        ["mermaid zoom button", ".mermaid-zoom-btn", [".ProseMirror .mermaid-preview", "hover"]],
        ["code block lang picker", ".lang-picker-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block copy", ".copy-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block word wrap", ".code-wrap-toggle-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block width", ".code-width-toggle-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block fullscreen", ".code-block-fullscreen-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block source toggle", ".code-view-toggle-btn", [".ProseMirror .code-float-rail", "hover"]],
        ["code block resize handle", ".code-block-resize-handle", null],
        ["callout kind button", ".callout-kind", null],
        ["callout kind menu item", ".callout-menu button", [".ProseMirror .callout-kind", "click"]],
        ["block width control", ".bc-btn", null],
        ["image toolbar button", ".img-tb-btn", [".ProseMirror .image-wrapper img", "click"]],
        ["image width control", ".img-tb-width", [".ProseMirror .image-wrapper img", "click"]],
        ["image zoom control", ".img-bc-zoom", [".ProseMirror .image-wrapper img", "click"]],
        ["footnote backlink", ".footnote-def-backlink", null],
        ["footnote ref", ".footnote-ref", null],
        ["wiki link", ".wiki-link", null],
        ["regular link", ".ProseMirror a:not(.wiki-link)", null],
        ["image reference chip", ".image-ref", null],
        // Selectable as a block, so tapping it raises the floating selection
        // toolbar; anything after it is aimed under that toolbar.
        ["link definition", ".link-definition", null],
        ["heading fold marker", ".heading-fold-marker", null],
        // Only drawn once something IS folded, which the subject above does.
        ["fold ellipsis", ".fold-ellipsis", null],
        ["heading fold toggle", ".heading-fold-toggle", null],
    ];
    // The FIRST match with a box, not the first match. Several of these classes
    // are on a control that every code block builds and only some show (the
    // source/preview toggle belongs to the diagram languages), so aiming at
    // `querySelector` alone reported a control the fixture renders perfectly
    // well as one it could not reach.
    const centre = (sel) => page.evaluate((s) => {
        const els = [...document.querySelectorAll(s)];
        if (els.length === 0) return null;
        const el = els.find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        if (!el) return { zero: true };
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
        // …and collapse the selection a previous subject left behind, which the
        // floating selection toolbar follows. That toolbar is not this audit's
        // subject and it covers the text under it.
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(300);
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
        // What is actually at the aim. A subject the floating selection toolbar
        // happens to be covering would otherwise report a clean landing on that
        // toolbar and be counted as driven, which is the "instrument measured
        // nothing" failure: the toolbar is outside the editable root, so its
        // verdict is trivially correct and says nothing about the subject.
        const obstruction = await page.evaluate(([s, x, y]) => {
            const target = [...document.querySelectorAll(s)].find((e) => {
                const r = e.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            const hit = document.elementFromPoint(x, y);
            if (!target || !hit) return "nothing is at the aim";
            // `closest` as well as containment: two instances of one kind of
            // chrome can overlap (the table's insert bars do at a corner), and
            // landing on the other instance is still landing on that chrome.
            if (target.contains(hit) || hit.contains(target) || hit.closest(s)) return null;
            return `${hit.tagName.toLowerCase()}.${String(hit.className?.baseVal ?? hit.className ?? "").split(" ")[0]}`;
        }, [sel.startsWith(".ProseMirror") ? sel : `.ProseMirror ${sel}`, box2.x, box2.y]);
        if (obstruction) { unreached.push([name, `obscured by ${obstruction}`]); continue; }
        const got = await tapTarget(box2.x, box2.y);
        (isRetargeted(got) ? retargeted : landed).push(`${name} -> ${show(got)}`);
    }
    check("a finger's contact lands on the chrome it was aimed at, never the text beside it",
        retargeted.length === 0, `retargeted: ${JSON.stringify(retargeted)}`);
    check("the touch sweep drove the subjects it claims to have driven",
        landed.length + retargeted.length + unreached.length === SUBJECTS.length &&
        landed.length + retargeted.length >= MIN_TOUCHED_SUBJECTS,
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
    //
    //       Declared here and called from section 4, which is where it has to
    //       run: it needs the task list on screen, and the subject sweep folds
    //       a heading away at its end.
    async function taskCheckboxProbe() {
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
}
