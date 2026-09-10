/**
 * A frame the editor embeds must not be able to speak into the editor.
 *
 * `webview/messaging.ts` accepts an inbound message only from this page's own
 * window or the window hosting it. The window that is neither is a frame the
 * page embeds, and `webview/utils/embedCard.ts` builds one per played embed
 * from a provider roster that includes hosts serving whatever a stranger
 * published. `externalUpdate` and `init` both carry a `content` that REPLACES
 * the document, which the sync pipeline then carries to the TextDocument and
 * to disk, so a forged one is a write to the user's file.
 *
 * The suite exists at this level because a unit test cannot ask the question.
 * What is under test is which window a real dispatch reports as its source,
 * and a constructed MessageEvent supplies that field itself: the assertion
 * would be reading back a value the test wrote. AGENTS.md names the class.
 *
 * Two traps shape the checks below, and both make a broken build pass a naive
 * version of this suite:
 *
 *  * "The document did not change" is also what a harness that never posted
 *    anything produces. So the forged message is asserted to have ARRIVED at
 *    the page (window.__probe, which records every message event with its
 *    sender classified) before its effect is asserted to be absent.
 *  * A check that only proves messages are ignored passes just as well when
 *    the inbound path is dead entirely. So a genuine `externalUpdate` from
 *    the host window is posted afterwards and asserted to APPLY. The pair is
 *    the discrimination; either alone is decoration.
 */
export async function run({ page, check, baseUrl }) {
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    await page.waitForTimeout(300);

    /** What the editor currently holds, as text. */
    const docText = () =>
        page.evaluate(() => document.querySelector(".milkdown .ProseMirror").textContent);

    /** Every message event the page saw, sender classified by index.html. */
    const probe = () => page.evaluate(() => window.__probe.slice());

    // The host's own init went through, which is what makes every later
    // assertion about the channel meaningful rather than vacuous.
    const opened = await docText();
    check("the host's own init opened the document", opened.includes("Original"), opened.slice(0, 60));

    // The frame is real and running: it answers the fire command, which it
    // could not do if it had failed to load or its script had been refused.
    const framed = await page.evaluate(() => {
        const frame = document.getElementById("hostile");
        if (!frame || !frame.contentWindow) { return false; }
        frame.contentWindow.postMessage({ type: "fire" }, "*");
        return true;
    });
    check("the embedded frame is present and was told to fire", framed);

    // Arrival, not effect. Without this the next check passes on a harness
    // that silently posted nothing at all.
    await page.waitForFunction(
        () => window.__probe.some((p) => p.from === "child"),
        null,
        { timeout: 5000 },
    ).catch(() => {});
    const afterForge = await probe();
    const fromChild = afterForge.filter((p) => p.from === "child");
    check("the forged messages reached the page from the embedded frame",
        fromChild.length === 2, JSON.stringify(afterForge));
    check("the forgeries were the two content-replacing types",
        fromChild.some((p) => p.type === "externalUpdate") && fromChild.some((p) => p.type === "init"),
        JSON.stringify(fromChild));

    // Effect, now that arrival is established.
    const afterForgeText = await docText();
    check("the forged content was not applied",
        afterForgeText.includes("Original") && !afterForgeText.includes("Forged"),
        afterForgeText.slice(0, 60));

    // The other half of the discrimination: the channel is still open to the
    // host. A suite without this one passes when onMessage is dead.
    await page.evaluate(() => {
        window.postMessage({
            type: "externalUpdate",
            content: "# Genuine\n\nfrom the host\n",
            syncVersion: 2,
        }, "*");
    });
    await page.waitForFunction(
        () => document.querySelector(".milkdown .ProseMirror").textContent.includes("Genuine"),
        null,
        { timeout: 5000 },
    ).catch(() => {});
    const afterGenuine = await docText();
    check("a genuine externalUpdate from the host window is still applied",
        afterGenuine.includes("Genuine"), afterGenuine.slice(0, 60));

    // The instrument saw both kinds, so the two verdicts above were taken on
    // the same channel rather than one of them measuring a channel that was
    // never exercised.
    const finalProbe = await probe();
    check("the probe recorded both a host message and a frame message",
        finalProbe.some((p) => p.from === "self") && finalProbe.some((p) => p.from === "child"),
        JSON.stringify(finalProbe));
}
