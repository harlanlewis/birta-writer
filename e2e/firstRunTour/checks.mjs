/**
 * The first-run tour, drawn.
 *
 * Two guards already read this document and neither can see it:
 * `shared/__tests__/firstRunNote.test.ts` asks whether its links are ones a
 * provider claims, and `webview/__tests__/firstRunNoteRoundTrip.test.ts` opens
 * it in a headless editor and asserts the bytes survive. Both run without a
 * layout engine, so "the mermaid diagram renders", "the math lays out", "the
 * table is a table" and "the boxes are boxes" were unasked of the one document
 * every new user is guaranteed to open — and the tour's own first instruction
 * is to click one of those boxes.
 *
 * The rendering constructs are lazily loaded chunks (mermaid, KaTeX) and
 * NodeViews (table, embed cards), which is why this is an e2e check rather
 * than a jsdom one: a lazy import that failed to resolve, or a NodeView that
 * threw at mount, leaves a document that parses correctly and shows the reader
 * raw source or nothing at all.
 *
 * `BIRTA_E2E_BROWSER=webkit` runs the same file in the engine the Mac app
 * renders in, which is the engine that actually opens this note.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The tour's markdown, read out of the Swift that ships it. */
function tourMarkdown() {
    const swift = readFileSync(
        join(REPO_ROOT, "jot/Sources/BirtaJotCore/FirstRunNote.swift"), "utf8");
    const body = /public static let markdown = """\n([\s\S]*?)\n {4}"""/.exec(swift)?.[1];
    if (body === undefined) {
        throw new Error("the tour's markdown literal could not be read out of FirstRunNote.swift");
    }
    // Swift strips the closing delimiter's indentation from every line.
    return body.split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
}

export async function run({ page, check, baseUrl }) {
    const tour = tourMarkdown();
    // The instrument, before anything is concluded from it: an extraction that
    // produced an empty string would mount a blank editor, and a suite written
    // over it would report a tour with nothing wrong.
    check("the tour was read out of the Swift", tour.length > 500 && tour.includes("```mermaid"),
        `${tour.length} chars`);

    await page.addInitScript((md) => { window.__TOUR = md; }, tour);
    await page.goto(`${baseUrl}/index.html`);
    await page.waitForSelector(".milkdown .ProseMirror", { timeout: 10000 });
    // The two lazy chunks the tour needs. Waiting on them rather than on a
    // timeout is what makes a failure here mean "it did not render" instead of
    // "it was slow".
    await page.waitForSelector(".mermaid-svg-container svg", { timeout: 20000 });
    await page.waitForSelector(".katex", { timeout: 20000 });
    await page.waitForTimeout(600); // NodeViews and fit-to-view settle

    // ── The document arrived whole ────────────────────────────────────────
    const shape = await page.evaluate(() => {
        const pm = document.querySelector(".ProseMirror");
        return {
            headings: pm.querySelectorAll("h1, h2").length,
            paragraphs: pm.querySelectorAll("p").length,
            text: pm.textContent ?? "",
        };
    });
    check("the tour mounted as a document, not as one blob",
        shape.headings >= 7 && shape.paragraphs > 10, JSON.stringify(shape.headings));
    // The type-along's own prose, so a document that mounted something else
    // entirely cannot satisfy the construct checks below by accident.
    check("its opening instruction is on screen",
        shape.text.includes("Press the same keys again"), shape.text.slice(0, 60));

    // ── The checklist, which is the first thing it asks for ───────────────
    const tasks = await page.evaluate(() => {
        const items = [...document.querySelectorAll(
            '.ProseMirror li[data-item-type="task"]')];
        return {
            count: items.length,
            checked: items.filter((li) => li.getAttribute("data-checked") === "true").length,
            // A box is drawn in a reserved column to the LEFT of the text, and
            // nothing draws it if the item rendered as a plain bullet. Measuring
            // that the text starts clear of the column is the layout truth
            // jsdom cannot answer.
            indented: items.filter((li) => {
                const p = li.querySelector("p");
                if (!p) { return false; }
                return p.getBoundingClientRect().left - li.getBoundingClientRect().left >= 12;
            }).length,
        };
    });
    check("every checklist line drew as a task item",
        tasks.count >= 9, JSON.stringify(tasks));
    check("…none of them arrives already ticked", tasks.checked === 0, JSON.stringify(tasks));
    check("…and each reserves the column its box is drawn in",
        tasks.indented === tasks.count, JSON.stringify(tasks));

    // ── The four constructs the tour claims render ────────────────────────
    const rendered = await page.evaluate(() => {
        const svg = document.querySelector(".mermaid-svg-container svg");
        const table = document.querySelector(".ProseMirror table");
        const math = document.querySelector(".katex");
        return {
            diagram: svg ? { w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height } : null,
            // Every node the flowchart names has to have been laid out, or the
            // diagram rendered as an error card, which is also an `svg`.
            diagramText: svg ? (svg.textContent ?? "") : "",
            rows: table ? table.querySelectorAll("tr").length : 0,
            cols: table ? (table.querySelector("tr")?.children.length ?? 0) : 0,
            tableWidth: table ? table.getBoundingClientRect().width : 0,
            math: math ? { w: math.getBoundingClientRect().width, text: math.textContent ?? "" } : null,
            // The raw source of any of these still on screen means the
            // construct did not take: the reader would see the markdown.
            rawFence: (document.querySelector(".ProseMirror").textContent ?? "").includes("```mermaid"),
        };
    });
    check("the diagram drew at a real size",
        rendered.diagram !== null && rendered.diagram.w > 50 && rendered.diagram.h > 20,
        JSON.stringify(rendered.diagram));
    check("…with the nodes the tour's flowchart names",
        /It stays your file/.test(rendered.diagramText) && /Render/.test(rendered.diagramText),
        rendered.diagramText.slice(0, 80));
    check("the table drew with its four rows and three columns",
        rendered.rows === 5 && rendered.cols === 3 && rendered.tableWidth > 100,
        JSON.stringify({ rows: rendered.rows, cols: rendered.cols, w: rendered.tableWidth }));
    check("the math laid out rather than showing its source",
        rendered.math !== null && rendered.math.w > 20 && /mc/.test(rendered.math.text),
        JSON.stringify(rendered.math));
    check("no fence is left on screen as source", !rendered.rawFence, String(rendered.rawFence));

    // ── The links, and the claim the tour makes about them ────────────────
    //
    // This is the check that found the section wrong. It said "A link alone on
    // its own line becomes a card" and then "Those cards are closed, and they
    // stay closed"; with the network switch off, which is how it ships, Loom
    // and Figma are both providers `providerCardGateOpen` refuses, so no card
    // is drawn at all and the reader is looking at two blue links under two
    // sentences about cards. Nothing could have caught it from the markdown:
    // the links are valid, the providers claim them, and the tour round-trips.
    //
    // What the section now says is what this asserts. The other direction —
    // that the gate DOES open once the network is on, so the tour is
    // demonstrating something real — is in `shared/__tests__/firstRunNote
    // .test.ts`, where asking it costs no outbound request.
    const links = await page.evaluate(() => {
        const pm = document.querySelector(".ProseMirror");
        const hrefs = [...pm.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
        return {
            cards: document.querySelectorAll(".embed-card-host").length,
            iframes: pm.querySelectorAll("iframe").length,
            loom: hrefs.filter((h) => h.includes("loom.com")).length,
            figma: hrefs.filter((h) => h.includes("figma.com")).length,
        };
    });
    check("both links are on screen as links", links.loom === 1 && links.figma === 1,
        JSON.stringify(links));
    check("…and neither drew a card, which is what the tour's callout now says",
        links.cards === 0 && links.iframes === 0, JSON.stringify(links));

    // Round-trip stability is deliberately NOT re-asked here: it is pinned
    // against the real serializer in `webview/__tests__/firstRunNoteRoundTrip
    // .test.ts`, which drives the same production code and can compare bytes
    // without a browser. What only a browser can answer is everything above.
    //
    // "no page errors" is the runner's own final check for every suite, so it
    // is not repeated here.
}
