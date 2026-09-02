/**
 * A wheel over a diagram pane scrolls the document, and nothing on the pane
 * cancels a wheel.
 *
 * Two questions, and they need two different instruments.
 *
 * Whether the page moves is what a reader feels, and only the browser's own
 * input pipeline can answer it, so that half uses `page.mouse.wheel`. It cannot
 * also answer the second question: the page scrolls on the compositor BEFORE
 * the event is delivered to script, so by the time a handler sees the wheel the
 * pane has moved several hundred pixels and `e.target` is whatever now sits
 * under the pointer. Asserting on that target reads as a targeting failure when
 * it is really evidence the scroll already happened.
 *
 * Whether anything on the pane cancels a wheel is a question about listeners,
 * and a dispatched event answers it exactly: it goes to the real handlers on
 * the real element and `defaultPrevented` is the verdict. It says nothing about
 * scrolling, which is why the first half exists.
 *
 * Both are needed. The pane once intercepted ctrl+wheel for pinch-to-zoom, and
 * the cost was not the branch but the listener: preventDefault needs
 * `{ passive: false }`, which takes every gesture over the element off the
 * compositor whether or not the branch fires. A movement check alone would pass
 * against a listener that inspected the event and returned early.
 */

const WHEEL_PX = 400;

/** Where to point, whether the pane overflows, and how far the page can go. */
async function geometry(page) {
    return page.evaluate(() => {
        const pane = document.querySelector(".mermaid-svg-container")?.parentElement ?? null;
        const prose = [...document.querySelectorAll(".ProseMirror > p")]
            .find((p) => {
                const r = p.getBoundingClientRect();
                return r.top > 80 && r.bottom < window.innerHeight - 40;
            });
        const centre = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        };
        return {
            pane: pane ? centre(pane) : null,
            prose: prose ? centre(prose) : null,
            // The pane must genuinely overflow, or the suite is asking its
            // question of a container that never had a claim to make.
            paneOverflows: pane ? pane.scrollWidth > pane.clientWidth : false,
            headroom: document.documentElement.scrollHeight - window.innerHeight - window.scrollY,
            scrollY: window.scrollY,
        };
    });
}

/**
 * Park the pointer over `what` and report what is actually under it.
 *
 * Moving the pointer into the editor reveals the hover chrome, which relayouts
 * under the cursor, so a centre measured before the move can be a paragraph by
 * the time anything happens there. This settles, re-measures and re-aims rather
 * than assuming one move landed.
 */
async function aim(page, what) {
    let at = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const centre = (await geometry(page))[what];
        if (!centre) return null;
        await page.mouse.move(centre.x, centre.y);
        await page.waitForTimeout(250);
        at = await page.evaluate(({ pt, w }) => {
            const el = w === "pane"
                ? document.querySelector(".mermaid-svg-container")?.parentElement
                : null;
            const under = document.elementFromPoint(pt.x, pt.y);
            return {
                x: pt.x, y: pt.y,
                onTarget: w === "pane" ? !!(el && under && el.contains(under)) : !!under,
                under: under ? `${under.nodeName}.${String(under.className?.baseVal ?? under.className ?? "").slice(0, 30)}` : null,
            };
        }, { pt: centre, w: what });
        if (at.onTarget) return at;
    }
    return at;
}

export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 20000 });
    await page.waitForTimeout(1200);

    const before = await geometry(page);
    check("the pane exists and its diagram overflows it",
        before.pane !== null && before.paneOverflows, JSON.stringify(before));
    // Without headroom the movement check below would fail for a reason that
    // has nothing to do with the pane.
    check("the page has somewhere to scroll to",
        before.headroom > WHEEL_PX, `headroom ${before.headroom}`);

    // ── Listeners: does anything on the pane cancel a wheel? ──
    // Dispatched at the deepest element the pointer would actually hit, so the
    // event travels the whole real ancestor chain up from inside the diagram.
    const cancelled = await page.evaluate(() => {
        const pane = document.querySelector(".mermaid-svg-container").parentElement;
        const r = pane.getBoundingClientRect();
        const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) ?? pane;
        const ev = new WheelEvent("wheel", {
            deltaY: 120, bubbles: true, cancelable: true, composed: true,
            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        });
        target.dispatchEvent(ev);
        const ctrl = new WheelEvent("wheel", {
            deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true, composed: true,
            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        });
        target.dispatchEvent(ctrl);
        return {
            from: `${target.nodeName}.${String(target.className?.baseVal ?? target.className ?? "").slice(0, 30)}`,
            insidePane: pane.contains(target),
            plain: ev.defaultPrevented,
            // The ctrl variant is the one the removed pinch handler keyed on,
            // so it is the case a reintroduced listener would cancel first.
            withCtrl: ctrl.defaultPrevented,
        };
    });
    check("the probe dispatches from inside the pane", cancelled.insidePane, JSON.stringify(cancelled));
    check("nothing on the pane cancels a plain wheel", cancelled.plain === false, JSON.stringify(cancelled));
    check("nor a ctrl+wheel, which is how a trackpad pinch arrives",
        cancelled.withCtrl === false, JSON.stringify(cancelled));

    // ── Behaviour: a real gesture over the pane scrolls the page ──
    const onPane = await aim(page, "pane");
    check("the pointer is parked over the pane", onPane !== null && onPane.onTarget,
        JSON.stringify(onPane));
    const paneStart = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, WHEEL_PX);
    await page.waitForTimeout(500);
    const afterPane = await page.evaluate(() => window.scrollY);
    check("a wheel over the diagram pane scrolls the document",
        afterPane - paneStart >= WHEEL_PX - 1,
        `moved ${afterPane - paneStart} of ${WHEEL_PX}`);

    // ── Control: the same gesture over prose ──
    // Without it, a page that could not scroll at all would fail the check
    // above for a reason that has nothing to do with the pane.
    const mid = await geometry(page);
    check("the control has room to run", mid.prose !== null && mid.headroom > WHEEL_PX,
        JSON.stringify({ prose: mid.prose, headroom: mid.headroom }));
    if (mid.prose && mid.headroom > WHEEL_PX) {
        await aim(page, "prose");
        const proseStart = await page.evaluate(() => window.scrollY);
        await page.mouse.wheel(0, WHEEL_PX);
        await page.waitForTimeout(500);
        const afterProse = await page.evaluate(() => window.scrollY);
        check("and the same gesture over prose moves it the same distance",
            afterProse - proseStart >= WHEEL_PX - 1,
            `moved ${afterProse - proseStart} of ${WHEEL_PX}`);
    }
}
