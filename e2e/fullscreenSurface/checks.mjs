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

    // Every wait here is on a CONDITION, never a duration. A fixed sleep is
    // both slower than it needs to be and weaker: it passes on a machine where
    // the thing never happened, as long as it never happens within the sleep.
    const gone = () => page.waitForFunction(
        () => !document.querySelector(".fs-surface"), { timeout: 8000 });

    const open = async () => {
        await page.evaluate(() => {
            const w = document.querySelector(".image-wrapper");
            // The control column attaches its buttons on first reveal.
            w.dispatchEvent(new PointerEvent("pointerenter"));
            [...w.querySelectorAll("button")]
                .find((b) => /full ?screen|zoom/i.test(b.getAttribute("aria-label") || ""))
                .click();
        });
        // The overlay animates in; the close paths below need it settled, and
        // "settled" is the animation ending, not a guessed number of ms.
        await page.waitForSelector(".fs-surface", { timeout: 8000 });
        await page.waitForFunction(
            () => !document.querySelector(".fs-surface")?.getAnimations()
                .some((a) => a.playState === "running"),
            { timeout: 8000 },
        );
    };

    await open();
    check("body scroll is locked while a lightbox is open",
        await page.evaluate(() => document.body.style.overflow === "hidden"));

    // The wrapper covers the overlay, so this is the path that silently stopped
    // working when the image left the overlay's direct children.
    await page.evaluate(() => {
        const content = document.querySelector(".fs-content");
        const box = content.getBoundingClientRect();
        content.dispatchEvent(new MouseEvent("mousedown", {
            bubbles: true, clientX: box.left + 8, clientY: box.top + 8,
        }));
    });
    await gone();
    check("a backdrop click dismisses the surface", true);
    check("body scroll is restored after close",
        await page.evaluate(() => document.body.style.overflow !== "hidden"));

    await open();
    await page.keyboard.press("Escape");
    await gone();
    check("Escape dismisses the surface", true);

    await open();
    await page.evaluate(() => document.querySelector(".fs-btn--close")
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await gone();
    check("the close button dismisses the surface", true);
}
