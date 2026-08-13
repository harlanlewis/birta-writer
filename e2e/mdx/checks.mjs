/**
 * MDX end-to-end checks against the real production bundle (MAR-350).
 *
 * jsdom already covers the mdx pipeline's round-trip fidelity
 * (roundTripCorpusMdx.test.ts). What only a browser can cover is what jsdom
 * has no machinery for: the lazy chunk actually resolving over the network,
 * the NodeViews actually rendering and their injected stylesheet actually
 * applying, and a markdown document actually paying nothing for any of it.
 *
 * The documents are the committed fixtures, read from disk rather than
 * restated here, so a fixture that stops parsing fails this suite too.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(new URL(".", import.meta.url))));
const fixture = (rel) => join(repoRoot, "webview/__tests__/fixtures", rel);

const PAINT_TIMEOUT_MS = 20000;

/**
 * Open one document in a fresh context. Returns the page plus the lazily
 * loaded chunk URLs it requested, which is how "the mdx module stayed off the
 * eager graph" is observable at all.
 */
async function open(browser, baseUrl, { content, format }) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    const chunks = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("request", (r) => {
        const u = new URL(r.url()).pathname;
        if (u.startsWith("/dist/chunks/")) chunks.push(u);
    });
    await page.addInitScript((init) => { window.__mdxInit = init; }, { content, format });
    await page.goto(`${baseUrl}/index.html`);
    return { ctx, page, errors, chunks };
}

/** Wait for the editor to paint; resolves false if it never does. */
async function painted(page) {
    try {
        await page.waitForFunction(
            () => performance.getEntriesByName("mdw:editor-painted").length > 0,
            { timeout: PAINT_TIMEOUT_MS },
        );
        return true;
    } catch {
        return false;
    }
}

export async function run({ page, check, baseUrl }) {
    const browser = page.context().browser();
    const docsPage = await readFile(fixture("mdx/docs-page.mdx"), "utf8");

    // ── 1. An .mdx document opens through the lazy format chunk ──────────
    const mdx = await open(browser, baseUrl, { content: docsPage, format: "mdx" });
    check("an .mdx document paints", await painted(mdx.page));
    check(
        "opening .mdx fetched the lazily split mdx chunk",
        mdx.chunks.some((c) => /\/mdx-/.test(c)),
        `chunks: ${mdx.chunks.join(", ") || "none"}`,
    );

    // ── 2. Every island rendered, inert, carrying its own source bytes ───
    const islands = await mdx.page.evaluate(() => {
        const read = (sel, textOf) =>
            [...document.querySelectorAll(sel)].map((el) => ({
                text: textOf(el),
                label: el.querySelector(".mdx-block-label")?.textContent ?? null,
                kind: el.getAttribute("data-kind"),
                editable: el.isContentEditable,
            }));
        return {
            blocks: read(".mdx-block", (el) => el.querySelector(".mdx-block-source")?.textContent ?? ""),
            inlines: read(".mdx-inline-chip", (el) => el.textContent ?? ""),
            scripts: document.querySelectorAll("#editor script").length,
        };
    });

    check(
        `flow islands rendered (${islands.blocks.length})`,
        islands.blocks.length >= 6,
        JSON.stringify(islands.blocks.map((b) => b.label)),
    );
    check(
        `inline islands rendered (${islands.inlines.length})`,
        islands.inlines.length >= 3,
        JSON.stringify(islands.inlines.map((i) => i.text)),
    );

    // The bytes on screen ARE the file's bytes: the whole preservation
    // contract, checked against the file rather than against the editor's own
    // idea of what it parsed.
    const notVerbatim = [...islands.blocks, ...islands.inlines]
        .filter((i) => !docsPage.includes(i.text))
        .map((i) => i.text);
    check(
        "every island's text is a verbatim slice of the file",
        notVerbatim.length === 0,
        JSON.stringify(notVerbatim.slice(0, 2)),
    );

    // Named islands, so a suite that rendered six of something unrelated
    // cannot pass the count checks above.
    const blockTexts = islands.blocks.map((b) => b.text);
    for (const want of [
        '<Chart data={metrics} color="#fcb32c" />',
        "<Chart data={metrics} color='#227788' />",
    ]) {
        check(`the island \`${want}\` rendered with its own quoting`, blockTexts.includes(want));
    }
    check(
        "an inline expression rendered as a chip",
        islands.inlines.some((i) => i.text === "{metrics.users}"),
        JSON.stringify(islands.inlines.map((i) => i.text)),
    );

    const labels = islands.blocks.map((b) => b.label);
    for (const want of ["MDX import/export", "JSX <Callout>", "MDX expression"]) {
        check(`a block is labelled "${want}"`, labels.includes(want), JSON.stringify(labels));
    }

    check("no island is editable", islands.blocks.every((b) => !b.editable));
    check("the document's code produced no script element", islands.scripts === 0);

    // The injected stylesheet is the mdx module's own, and jsdom cannot tell
    // whether it applied. A block with no border is a stylesheet that did not.
    const blockBorder = await mdx.page
        .locator(".mdx-block").first()
        .evaluate((el) => getComputedStyle(el).borderTopWidth);
    check("mdx block styles were injected and applied", blockBorder !== "0px", blockBorder);

    // ── 3. A prose edit preserves every island verbatim on the way out ───
    // The paragraph is addressed by its text, not by position: an island is a
    // selectable atom, so a click that lands on one and a keystroke REPLACE
    // it, and a positional selector that drifted onto an island would report
    // that ordinary deletion as a preservation failure.
    await mdx.page.getByText("Docs sites mix prose with components").click();
    // Chromium delivers `selectionchange` asynchronously, and ProseMirror
    // reads its own selection from that event. Typing in the same turn as the
    // click arrives while state.selection is still the mount-time one, which
    // for this document is a NodeSelection on the leading island: the
    // keystroke then REPLACES the island and the check reads as a
    // preservation failure that no product change could fix.
    await mdx.page.waitForTimeout(150);
    await mdx.page.keyboard.type("EDITED ");
    await mdx.page.waitForTimeout(700);
    await mdx.page.waitForTimeout(700);
    const serialized = await mdx.page.evaluate(() => {
        const updates = window.__posted.filter((m) => m.type === "update");
        return updates.length ? updates[updates.length - 1].content : null;
    });
    // The edit must land in the paragraph, not merely somewhere in the file:
    // the block carrying "Docs sites" is the one that has to have grown.
    const editedBlock = (serialized ?? "")
        .split(/\n\s*\n/)
        .find((b) => b.includes("Docs sites mix prose"));
    check(
        "a prose edit reached the host, inside the paragraph it was typed in",
        (editedBlock ?? "").includes("EDITED"),
        JSON.stringify(editedBlock ?? (serialized ?? "").slice(0, 120)),
    );
    if (typeof serialized === "string") {
        const lost = [...islands.blocks, ...islands.inlines]
            .map((i) => i.text)
            .filter((t) => !serialized.includes(t));
        check(
            "every island survives a prose edit byte for byte",
            lost.length === 0,
            JSON.stringify(lost.slice(0, 2)),
        );
    }

    check("the .mdx page logged no errors", mdx.errors.length === 0, mdx.errors.slice(0, 2).join(" | "));
    await mdx.ctx.close();

    // ── 4. Invalid MDX is fatal, positioned, and never silently blank ────
    const broken = await open(browser, baseUrl, {
        content: "first line\n\nsecond {unclosed\n",
        format: "mdx",
    });
    await broken.page.waitForFunction(
        () => window.__posted.some((m) => m.type === "fatalParse"),
        { timeout: PAINT_TIMEOUT_MS },
    ).catch(() => {});
    const fatal = await broken.page.evaluate(() => {
        const m = window.__posted.find((x) => x.type === "fatalParse");
        return {
            posted: m ?? null,
            banner: document.querySelector(".fatal-parse-banner")?.textContent ?? null,
            editors: document.querySelectorAll(".milkdown .ProseMirror").length,
        };
    });
    check("invalid MDX posts fatalParse", fatal.posted !== null, JSON.stringify(fatal.posted));
    check(
        "fatalParse carries the parser's line and column",
        fatal.posted?.line === 3 && typeof fatal.posted?.column === "number",
        JSON.stringify(fatal.posted),
    );
    check(
        "the fatal-parse banner explains rather than leaving the pane blank",
        (fatal.banner ?? "").includes("not valid MDX"),
        JSON.stringify(fatal.banner),
    );
    check("no editor mounted for an unparseable document", fatal.editors === 0);
    await broken.ctx.close();

    // ── 5. A markdown document pays nothing for any of this ──────────────
    const md = await open(browser, baseUrl, {
        content: "# Plain\n\nJust prose, no islands.\n",
        format: "markdown",
    });
    check("a markdown document paints", await painted(md.page));
    // Not "no chunks at all": esbuild splits the EAGER graph across chunks
    // too, so every document loads several. The claim is narrower and is the
    // one format/loader.ts actually makes.
    check(
        "a markdown document loads no mdx chunk",
        !md.chunks.some((c) => /\/mdx-/.test(c)),
        `chunks: ${md.chunks.join(", ")}`,
    );
    const mdIslands = await md.page.evaluate(
        () => document.querySelectorAll(".mdx-block, .mdx-inline-chip, #mdx-node-styles").length,
    );
    check("a markdown document renders no mdx node or stylesheet", mdIslands === 0);
    check("the markdown page logged no errors", md.errors.length === 0, md.errors.slice(0, 2).join(" | "));
    await md.ctx.close();
}
