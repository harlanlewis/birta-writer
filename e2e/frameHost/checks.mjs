/**
 * A frame embed in an application that is not an editor (MAR-451, MAR-447).
 *
 * Every host so far handed the editor a whole page it owned: VS Code's
 * webview, the Mac app's WKWebView, every other harness page here. This suite
 * is the one where it does not. index.html is an ordinary page with a title
 * field and a Save button that holds the document's bytes in a variable and
 * puts the editor in an <iframe>; editor.html beside it is the frame page,
 * which is the whole of what an embedder has to serve (docs/HOSTING.md is the
 * same contract in prose). Everything crosses the frame boundary as
 * postMessage, and the host answers exactly what the contract says a host
 * must: `ready` with `init`, and nothing else unless it asks.
 *
 * What it holds, in order: the editor boots and edits in a frame of a page it
 * does not own; the edit reaches the host as `update` without the host being
 * asked anything; a host-driven `flushSave` returns the live bytes, which is
 * the save-before-persist half of the contract; `externalUpdate` and
 * `setReadOnly` from the host take effect; an EMPTY profile withdraws every
 * control that names something the host does not have while an undeclared
 * one inherits the VS Code profile's controls; the messages the editor posts
 * on its own are the short list the doc names; a pasted image on a host with
 * no image store is refused in place rather than posted; and the frame keeps
 * its hands off the host's focus at boot.
 */
export async function run({ page, check, baseUrl }) {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") { errors.push(m.text()); } });

    /** Open the host page, focus its own title field at once, and wait for the editor. */
    async function open(query = "") {
        await page.goto(`${baseUrl}/index.html${query}`);
        // Before the frame has booted: what a person who landed on the page
        // and clicked into a field of the host's own would have.
        await page.focus("#title");
        const frame = page.frame({ url: /editor\.html/ });
        await frame.waitForSelector(".milkdown .ProseMirror", { timeout: 15000 });
        await page.waitForFunction(
            () => window.__log.some((e) => e.dir === "out" && e.msg.type === "wordCount"),
            { timeout: 10000 },
        );
        await page.waitForTimeout(300);
        return frame;
    }
    const postedTypes = () => page.evaluate(() => window.__log.filter((e) => e.dir === "out").map((e) => e.msg.type));
    const distinct = (list) => [...new Set(list)].sort();

    // ── Boot, in a frame, under an empty profile ───────────────────────
    let frame = await open();
    const bootTypes = distinct(await postedTypes());
    check("frame: the editor boots inside a page that is not an editor", await frame.locator(".milkdown .ProseMirror").count() === 1);
    check("frame: the host's own field keeps focus through the editor's boot",
        (await page.evaluate(() => document.activeElement?.id)) === "title");

    // What a host is told without asking. The list is the contract's, and a
    // new member is a new thing every embedder has to be told to expect.
    const UNPROMPTED = ["focusState", "ready", "wordCount"];
    check("frame: boot posts only the messages the contract names as unprompted",
        bootTypes.every((t) => UNPROMPTED.includes(t)) && bootTypes.includes("ready"),
        JSON.stringify(bootTypes));

    // ── An edit reaches the host, and the host is asked nothing ────────
    await frame.locator(".ProseMirror").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" typed in a frame");
    await page.waitForFunction(() => /typed in a frame/.test(document.getElementById("mirror").value), { timeout: 10000 });
    const mirror = await page.$eval("#mirror", (el) => el.value);
    check("frame: typing reaches the host as `update` carrying the Markdown",
        /^# Hello typed in a frame/.test(mirror), JSON.stringify(mirror.slice(0, 60)));
    const afterTyping = distinct(await postedTypes());
    const TYPING = [...UNPROMPTED, "update", "viewState"];
    check("frame: typing asks the host nothing beyond update and the view-state echo",
        afterTyping.every((t) => TYPING.includes(t)), JSON.stringify(afterTyping));

    // ── flushSave: the freshest bytes, on demand, before the host persists ──
    await page.keyboard.type(" and flushed");
    // Straight away, inside the sync scheduler's window, so the flush and not
    // an `update` is what carries the last words.
    const flushed = await page.evaluate(() => window.__flush());
    check("frame: flushSave answers with bytes fresher than the last update",
        /typed in a frame and flushed/.test(flushed), JSON.stringify(flushed.slice(0, 80)));

    // ── externalUpdate: the host replaces the document ─────────────────
    await page.click("#replace");
    await frame.waitForFunction(() => /The host set this/.test(document.querySelector(".ProseMirror")?.textContent ?? ""), { timeout: 5000 });
    check("frame: externalUpdate from the host replaces the content",
        !/typed in a frame/.test(await frame.locator(".ProseMirror").textContent()));

    // ── setReadOnly: the host locks editing ────────────────────────────
    await page.click("#readonly");
    await frame.locator(".ProseMirror").click();
    await page.keyboard.type("XYZ");
    await page.waitForTimeout(200);
    check("frame: setReadOnly from the host stops a keystroke changing the document",
        !/XYZ/.test(await frame.locator(".ProseMirror").textContent()));
    await page.click("#readonly");

    // ── The empty profile withdraws what names the host ────────────────
    const chrome = async () => frame.evaluate(() => ({
        items: [...document.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId),
        toc: !!document.querySelector(".toc-panel"),
    }));
    const empty = await chrome();
    const HOST_BOUND = ["image", "viewSource", "readOnly", "toc"];
    check("empty profile: no toolbar item names something the host has not declared",
        HOST_BOUND.every((id) => !empty.items.includes(id)) && !empty.toc, JSON.stringify(empty));
    check("empty profile: the editor's own items are all still built",
        ["format", "bold", "link", "table", "find", "settings"].every((id) => empty.items.includes(id)),
        JSON.stringify(empty.items));
    const gearBtn = frame.locator('[data-item-id="settings"] .tb-fmt-btn');
    await gearBtn.click();
    await page.waitForTimeout(250);
    const gearRows = await frame.$$eval('[data-item-id="settings"] .tb-settings-menu .ui-menu-row',
        (els) => els.map((el) => el.textContent.trim()).filter(Boolean));
    check("empty profile: the gear menu offers no VS Code settings, keybindings or release-notes row",
        gearRows.length > 0 && !gearRows.some((r) => /Settings|Keyboard Shortcuts$|What's New/.test(r) && !/Show Keyboard/.test(r)),
        JSON.stringify(gearRows));
    await page.keyboard.press("Escape");

    // ── A pasted image on a host with no image store ───────────────────
    //
    // The command is withdrawn already; the paste path is what reaches the
    // save without one. The refusal is in place and immediate, and the host
    // is never posted an `uploadImage` it cannot answer.
    const beforePaste = (await postedTypes()).length;
    await frame.evaluate(() => {
        const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([png], "x.png", { type: "image/png" }));
        document.querySelector(".ProseMirror").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(400);
    const pill = await frame.locator(".img-upload-pill").textContent().catch(() => null);
    check("empty profile: a pasted image is refused in place, naming the reason",
        pill !== null && /not saved/.test(pill) && /no image store/.test(pill), JSON.stringify(pill));
    check("empty profile: and the host is never posted an upload it cannot answer",
        !(await postedTypes()).slice(beforePaste).includes("uploadImage"));

    // ── The undeclared profile is the VS Code one ──────────────────────
    //
    // The arm that keeps the checks above a difference: an embedder that
    // declares nothing inherits every capability, and is then asked for all
    // of them. `lintBlocks` at boot is the visible half of that.
    frame = await open("?profile=absent");
    const absent = await chrome();
    // `readOnly` is not among them: the VS Code profile has the capability and
    // does not put the item on the bar by default, so its presence would test
    // the layout rather than the gate.
    check("undeclared profile: the host-bound items and the sidebar are all built",
        ["image", "viewSource", "toc"].every((id) => absent.items.includes(id)) && absent.toc, JSON.stringify(absent));
    check("undeclared profile: the editor asks the host to lint, because the VS Code profile says it can",
        (await postedTypes()).includes("lintBlocks"));

    check("no page errors in either frame", errors.length === 0, JSON.stringify(errors));
}
