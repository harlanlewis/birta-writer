/**
 * The shared fullscreen surface's contract (ui/fullscreenSurface.ts).
 *
 * Every "open this bigger" gesture — diagram, code block, image, embedded
 * player — runs through one shell now. Before that they were four hand-rolled
 * overlays, and the drift was invisible from any one of them: the image
 * lightbox never locked body scroll, and only the diagram used the shared
 * dismiss layer. What this suite pins is the anatomy they now share, driven
 * through the IMAGE surface because it is the cheapest one to open (no engine,
 * no network). The diagram surface's own behaviour lives in e2e/plantUmlRender.
 *
 * The backdrop-click check earns its place twice over. The shell wraps content
 * in a `.fs-content` element that covers the overlay edge to edge, so the
 * overlay itself stops receiving the click that used to dismiss it — a
 * regression with no visible symptom other than a click that does nothing.
 *
 * jsdom cannot stand in: these are computed styles, real event dispatch, and
 * the Escape layer's interaction with a focused overlay.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector("img.image-node", { timeout: 20000 });
    await new Promise(r => setTimeout(r, 700));
    const open = async () => {
        await page.evaluate(() => {
            const w = document.querySelector(".image-wrapper");
            w.dispatchEvent(new PointerEvent("pointerenter"));
            const btn = [...w.querySelectorAll("button")]
                .find(b => /full ?screen|zoom/i.test(b.getAttribute("aria-label") || ""));
            btn.click();
        });
        await page.waitForSelector(".fs-surface", { timeout: 8000 });
        await new Promise(r => setTimeout(r, 400));
    };
    await open();
    check("body scroll is locked while a lightbox is open",
        await page.evaluate(() => document.body.style.overflow === "hidden"), "");
    // Backdrop click: the wrapper covers the overlay, so this is the path that
    // silently stopped working when the image left the overlay's direct children.
    await page.evaluate(() => {
        const c = document.querySelector(".fs-content");
        const r = c.getBoundingClientRect();
        c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: r.left + 8, clientY: r.top + 8 }));
    });
    await new Promise(r => setTimeout(r, 600));
    check("a backdrop click dismisses the surface",
        await page.evaluate(() => !document.querySelector(".fs-surface")), "");
    check("body scroll is restored after close",
        await page.evaluate(() => document.body.style.overflow !== "hidden"), "");
    // Escape
    await open();
    await page.keyboard.press("Escape");
    await new Promise(r => setTimeout(r, 600));
    check("Escape dismisses the surface",
        await page.evaluate(() => !document.querySelector(".fs-surface")), "");
    // Close button
    await open();
    await page.evaluate(() => document.querySelector(".fs-btn--close")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await new Promise(r => setTimeout(r, 600));
    check("the close button dismisses the surface",
        await page.evaluate(() => !document.querySelector(".fs-surface")), "");
}
