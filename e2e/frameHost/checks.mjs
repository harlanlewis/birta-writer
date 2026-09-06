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
 * Every claim below is a DIFFERENCE between the two profile arms wherever a
 * difference can carry it, rather than a list written here: a control that
 * becomes host-gated joins this guard by being gated, and the pair of
 * "declaring less only withdraws" plus "the two arms differ at all" is what a
 * written list cannot say. That the arms differ is asserted before anything is
 * read from the difference, so a build that gated nothing fails here instead
 * of passing every comparison vacuously.
 *
 * Engine coverage: Chromium. The Mac app renders in WebKit and the repo's rule
 * is that anything editing the document from the keyboard gets a
 * `BIRTA_E2E_BROWSER=webkit` run, which this suite has not had. A frame embed
 * has no WebKit host today, so the gap is a claim about the suite rather than
 * about a shipped surface, and it closes the day an embedder renders in one.
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
    // The MODE, waited for as a condition, before typing at it. Asserting only
    // that a keystroke changed nothing cannot tell read-only from a keystroke
    // that missed the editor, and there is no condition to wait on for a
    // document that must not change.
    const editable = () => frame.$eval(".ProseMirror", (el) => el.getAttribute("contenteditable"));
    await frame.waitForFunction(
        () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "false",
        { timeout: 5000 },
    ).catch(() => {});
    check("frame: setReadOnly from the host puts the editor in read-only mode",
        (await editable()) === "false", JSON.stringify(await editable()));
    await frame.locator(".ProseMirror").click();
    await page.keyboard.type("XYZ");
    await page.waitForTimeout(200);
    check("frame: and a keystroke then changes nothing",
        !/XYZ/.test(await frame.locator(".ProseMirror").textContent()));
    await page.click("#readonly");
    await frame.waitForFunction(
        () => document.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true",
        { timeout: 5000 },
    ).catch(() => {});
    check("frame: and turning it back off makes the document editable again",
        (await editable()) === "true", JSON.stringify(await editable()));

    // ── What the empty profile withdraws, as a DIFFERENCE ──────────────
    //
    // Measured against the undeclared arm rather than written down here, so
    // a newly gated control joins this guard by being gated. A hand-written
    // list is one a new case never joins, and it also hides the case that
    // passes for the wrong reason: `readOnly` is absent under BOTH profiles,
    // because the VS Code profile has the capability and still keeps the item
    // off the bar, so asserting its absence here discriminated nothing.
    const chrome = async () => frame.evaluate(() => ({
        items: [...document.querySelectorAll(".tb-item")].map((el) => el.dataset.itemId),
        toc: !!document.querySelector(".toc-panel"),
    }));
    /** The gear menu's rows, opened and read, then closed. */
    const GEAR_ROW = '[data-item-id="settings"] .tb-settings-menu .ui-menu-row';
    async function gearRows() {
        await frame.locator('[data-item-id="settings"] .tb-fmt-btn').click();
        // The menu having rows is the condition; a clock here would read an
        // empty menu as an empty menu on a slow machine.
        await frame.waitForSelector(GEAR_ROW, { timeout: 5000 });
        const rows = await frame.$$eval(GEAR_ROW, (els) => els.map((el) => el.textContent.trim()).filter(Boolean));
        // The pointer is what closes it, not Escape. With no arrangement
        // declared these menus open on HOVER, so a pointer left resting on the
        // trigger reopens the menu the moment Escape dismisses it.
        await page.mouse.move(5, 500);
        // Hidden rather than detached: the rows stay in the DOM and the menu
        // is display:none when shut, so a detached wait never returns.
        await frame.waitForSelector(GEAR_ROW, { state: "hidden", timeout: 5000 });
        return rows;
    }
    const empty = await chrome();
    const emptyGear = await gearRows();

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
    // Reach first, verdict second. Without this the one failure message
    // covers both "the editor reported the wrong thing" and "the paste never
    // reached the plugin", and only the first is a defect in the editor.
    const reached = await frame.waitForSelector(".img-upload-pill", { timeout: 5000 })
        .then(() => true, () => false);
    check("empty profile: the pasted image reached the save path at all", reached);
    const pill = reached ? await frame.locator(".img-upload-pill").textContent() : null;
    check("empty profile: a pasted image is refused in place, naming the reason",
        pill !== null && /not saved/.test(pill) && /no image store/.test(pill), JSON.stringify(pill));
    check("empty profile: and the host is never posted an upload it cannot answer",
        !(await postedTypes()).slice(beforePaste).includes("uploadImage"));

    // ── The undeclared profile is the VS Code one ──────────────────────
    //
    // The arm every check above is a difference against: an embedder that
    // declares nothing inherits every capability, and is then asked for all
    // of them. `lintBlocks` at boot is the visible half of that.
    frame = await open("?profile=absent");
    const absent = await chrome();
    const absentGear = await gearRows();
    check("undeclared profile: the editor asks the host to lint, because the VS Code profile says it can",
        (await postedTypes()).includes("lintBlocks"));

    const withdrawnItems = absent.items.filter((id) => !empty.items.includes(id));
    const gainedItems = empty.items.filter((id) => !absent.items.includes(id));
    const withdrawnRows = absentGear.filter((r) => !emptyGear.includes(r));
    const gainedRows = emptyGear.filter((r) => !absentGear.includes(r));

    // The instrument reached something. A build that gated nothing would
    // leave both differences empty and every claim below vacuously true.
    check("the two profiles differ at all, so the comparisons below mean something",
        withdrawnItems.length > 0 && withdrawnRows.length > 0,
        JSON.stringify({ withdrawnItems, withdrawnRows }));

    // The invariant a written list cannot express: declaring LESS may only
    // take chrome away. Anything appearing under the empty profile and not
    // the VS Code one is a control built for a host that never claimed it.
    check("declaring less only ever withdraws: the empty profile gains no item and no gear row",
        gainedItems.length === 0 && gainedRows.length === 0,
        JSON.stringify({ gainedItems, gainedRows }));

    // The floor under the difference, so the guard still makes a specific
    // claim rather than only a shape one.
    check("the withdrawn items are the ones that name a host: an image store and a text editor",
        ["image", "viewSource"].every((id) => withdrawnItems.includes(id)), JSON.stringify(withdrawnItems));
    check("the sidebar is the host's too, and goes with them",
        absent.toc && !empty.toc && withdrawnItems.includes("toc"),
        JSON.stringify({ emptyToc: empty.toc, absentToc: absent.toc }));
    check("the withdrawn gear rows are VS Code's settings, keybindings and release notes",
        withdrawnRows.length === 3 && withdrawnRows.every((r) => /Settings|Keyboard Shortcuts|What's New/.test(r)),
        JSON.stringify(withdrawnRows));
    check("and the rows the editor owns survive, so the menu is not simply empty",
        emptyGear.some((r) => /Customize Toolbar/.test(r)) && emptyGear.some((r) => /Show Keyboard Shortcuts/.test(r)),
        JSON.stringify(emptyGear));
    check("the editor's own toolbar items are built under both profiles",
        ["format", "bold", "link", "table", "find", "settings"]
            .every((id) => empty.items.includes(id) && absent.items.includes(id)),
        JSON.stringify(empty.items));

    check("no page errors in either frame", errors.length === 0, JSON.stringify(errors));
}
