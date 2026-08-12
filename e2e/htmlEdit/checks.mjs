/**
 * Editable HTML end-to-end (MAR-14), against the real bundle: a real click
 * on the html atom opens the source panel, a real blur commits, and the
 * committed bytes reach the serialized document the webview posts out.
 * Also pins the live-pair rendering jsdom can only assert structurally:
 * the decoration spans exist with their classes in a painted layout.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    const latest = () =>
        page.evaluate(() => {
            const ups = window.__posted.filter((m) => m.type === "update");
            return ups.length ? ups[ups.length - 1].content : null;
        });

    // Live pair painted: the text between <kbd>...</kbd> carries the class.
    const kbdLive = await page.evaluate(() => {
        const el = document.querySelector(".ProseMirror .html-live-kbd");
        return el ? el.textContent : null;
    });
    check("the <kbd> pair renders live", kbdLive === "Ctrl", String(kbdLive));

    const pairedTags = await page.evaluate(() =>
        document.querySelectorAll(".ProseMirror .html-tag--paired").length);
    check("both tag atoms are dimmed chips", pairedTags === 2, String(pairedTags));

    // A real click on the comment chip opens the source panel.
    await page.click(".ProseMirror .html-comment");
    const areaVisible = await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    check("clicking the comment chip opens the source panel", !!areaVisible, "no textarea");

    const raw = await page.evaluate(() =>
        document.querySelector(".ProseMirror textarea.html-src").value);
    check("the panel holds the raw comment bytes", raw === "<!-- editorial -->", raw);

    // Type a new value and commit by clicking back into the document.
    await page.evaluate(() => {
        const area = document.querySelector(".ProseMirror textarea.html-src");
        area.value = "<!-- reviewed -->";
    });
    await page.click(".ProseMirror p");
    await page.waitForTimeout(600);

    const doc = await latest();
    check("the committed bytes reach the serialized document",
        doc !== null && doc.includes("<!-- reviewed -->") && !doc.includes("<!-- editorial -->"),
        String(doc));

    check("the pair bytes are untouched by decoration",
        doc !== null && doc.includes("Press <kbd>Ctrl</kbd> to run."),
        String(doc));

    // The panel is gone after the commit.
    const areaGone = await page.evaluate(() =>
        document.querySelector(".ProseMirror textarea.html-src") === null);
    check("the panel closes on commit", areaGone, "textarea still present");

    // Mode-switch story (selectionSurfaceCoverage's ISLAND_REGISTRY entry):
    // with the panel open, the parked ProseMirror selection is a
    // NodeSelection on the atom itself, so a switch targets the atom's own
    // source line — the comment paragraph is body line 3 — and
    // getSwitchTarget blurs the panel first, so a mid-edit value is
    // committed rather than discarded, even with no natural blur.
    await page.click(".ProseMirror .html-comment");
    await page.waitForSelector(".ProseMirror textarea.html-src", { timeout: 5000 });
    await page.evaluate(() => {
        document.querySelector(".ProseMirror textarea.html-src").value = "<!-- switched away -->";
    });
    await page.evaluate(() => window.postMessage({ type: "requestSwitchToTextEditor" }, "*"));
    await page.waitForTimeout(600);
    const switchTarget = await page.evaluate(() => {
        const posted = window.__posted.filter((m) => m.type === "switchToTextEditor");
        return posted[posted.length - 1] ?? null;
    });
    check("a switch from the open panel targets the html atom's line",
        switchTarget !== null && switchTarget.line === 3,
        JSON.stringify(switchTarget));
    const afterSwitch = await latest();
    check("a mid-edit panel value is committed by the switch, not discarded",
        afterSwitch !== null && afterSwitch.includes("<!-- switched away -->"),
        String(afterSwitch));
}
