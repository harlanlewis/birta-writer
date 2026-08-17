/**
 * Link cards (MAR-185): a lone web link on its own line, shown as a quiet
 * card of the page's Open Graph title, description and site, as a render-only
 * decoration on the embed plugin. Against a REAL Milkdown document, like
 * embedDecorations.test.ts.
 *
 * The invariants under test:
 *  - Off by default: with `birta.linkCards.enabled` off and no per-link
 *    choice, a lone link is a link, and the plugin walks nothing for cards.
 *  - The gate: default on + network on cards a bare AND a labelled lone
 *    link; network off cards nothing whatever was chosen; a per-link choice
 *    wins over the default in both directions.
 *  - A provider link keeps its provider card; a URL mid-prose is never a
 *    card; a link card asks the extension for its page's metadata once, and
 *    the reply fills the card without touching the document.
 *  - The block menu offers "Show as Card" / "Show as Link" for a lone link
 *    and the choice repaints; the source markdown is byte-identical after.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { DecorationSet } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { computeEmbedDecorations, embedPlugin, regateEmbeds } from "../plugins/embed";
import { headingFoldPlugin } from "../plugins/headingFold";
import { renderEmbedCard } from "../utils/embedCard";
import { closeBlockMenu, setBlockMenuContext } from "../components/blockMenu";
import { chooseLinkCardDisplay, linkCardAnchor, linkCardSite, soleLinkHref } from "../linkCards";
import { setLinkCardDisplay } from "../blockWidth";
import { _resetLinkCardMetaForTests, handleLinkCardResult, queueLinkCardResolution, subscribeLinkCardMeta } from "../linkCardMeta";
import { mockVscodeApi } from "./setup";

const PAGE = "https://example.com/some/article";
const OTHER = "https://example.org/other";
const YT = "https://youtu.be/dQw4w9WgXcQ";

function i18n(overrides: Record<string, unknown>): void {
    window.__i18n = { translations: {}, network: true, ...overrides } as unknown as typeof window.__i18n;
}

/** Widget keys of a decoration set (the card identities). */
function widgetKeys(set: DecorationSet): string[] {
    return set.find()
        .filter((d) => d.from === d.to)
        .map((d) => String((d.spec as { key?: string }).key ?? ""));
}

beforeEach(() => {
    i18n({});
    _resetLinkCardMetaForTests();
    mockVscodeApi.postMessage.mockClear();
    // The per-link store is module state: clear the anchors these tests use.
    setLinkCardDisplay(linkCardAnchor(PAGE), null);
    setLinkCardDisplay(linkCardAnchor(OTHER), null);
});

afterEach(() => {
    closeBlockMenu();
    delete window.__i18n;
    document.body.innerHTML = "";
});

describe("soleLinkHref", () => {
    it("a bare autolink and a labelled link alone on a line should both qualify, prose should not", async () => {
        const editor = await makeCorpusEditor(
            `${PAGE}\n\n[an article](${PAGE})\n\nread ${PAGE} today\n\n[local](./notes.md)\n`,
        );
        const doc = editorView(editor).state.doc;
        const hrefs: (string | null)[] = [];
        doc.forEach((node) => hrefs.push(soleLinkHref(node)));
        expect(hrefs).toEqual([PAGE, PAGE, null, null]);
    });

    it("linkCardSite should name the host without www", () => {
        expect(linkCardSite("https://www.example.com/a/b")).toBe("example.com");
        expect(linkCardSite("https://docs.example.org")).toBe("docs.example.org");
    });
});

describe("the gate", () => {
    it("with the default off and no per-link choice, a lone link should stay a link", async () => {
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n\n[an article](${PAGE})\n`);
        const view = editorView(editor);
        expect(computeEmbedDecorations(view.state).find()).toHaveLength(0);
    });

    it("default on + network on should card a bare and a labelled lone link, and not prose", async () => {
        i18n({ linkCardsEnabled: true });
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n\n[an article](${OTHER})\n\nread ${PAGE} today\n`);
        const view = editorView(editor);
        expect(widgetKeys(computeEmbedDecorations(view.state))).toEqual([
            `embed:linkCard:${PAGE}:0`,
            `embed:linkCard:${OTHER}:0`,
        ]);
    });

    it("network off should card nothing, whatever the default or the choice says", async () => {
        i18n({ linkCardsEnabled: true, network: false });
        setLinkCardDisplay(linkCardAnchor(PAGE), "card");
        const editor = await makeCorpusEditor(`${PAGE}\n`);
        const view = editorView(editor);
        expect(computeEmbedDecorations(view.state).find()).toHaveLength(0);
    });

    it("a per-link choice should win over the default in both directions", async () => {
        // The caret rests in the heading: a caret inside a carded paragraph
        // reveals the link, which is its own test below.
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n\n${OTHER}\n`);
        const view = editorView(editor);
        // Default off, PAGE chosen as a card: only PAGE cards.
        chooseLinkCardDisplay(linkCardAnchor(PAGE), "card");
        expect(widgetKeys(computeEmbedDecorations(view.state))).toEqual([`embed:linkCard:${PAGE}:0`]);
        // Default on, PAGE chosen as text: only OTHER cards.
        i18n({ linkCardsEnabled: true });
        chooseLinkCardDisplay(linkCardAnchor(PAGE), "text");
        expect(widgetKeys(computeEmbedDecorations(view.state))).toEqual([`embed:linkCard:${OTHER}:0`]);
    });

    it("a provider link should keep its provider card and never become a link card", async () => {
        i18n({ linkCardsEnabled: true });
        const editor = await makeCorpusEditor(`# T\n\n${YT}\n\n${PAGE}\n`);
        const view = editorView(editor);
        expect(widgetKeys(computeEmbedDecorations(view.state))).toEqual([
            "embed:youtube:dQw4w9WgXcQ:0",
            `embed:linkCard:${PAGE}:0`,
        ]);
    });

    it("the caret inside a carded paragraph should reveal the raw link", async () => {
        i18n({ linkCardsEnabled: true });
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n`);
        const view = editorView(editor);
        const paragraphPos = view.state.doc.child(0).nodeSize;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, paragraphPos + 2)));
        expect(computeEmbedDecorations(view.state).find()).toHaveLength(0);
    });

    it("decorations should never touch the document: the source round-trips byte-identical", async () => {
        i18n({ linkCardsEnabled: true });
        // A labelled link, because getMarkdown() bypasses the fidelity
        // layer and respells a bare autolink as <url> with or without cards.
        const source = `# T\n\n[an article](${OTHER})\n\n[another](${PAGE})\n`;
        const editor = await makeCorpusEditor(source, [embedPlugin]);
        const view = editorView(editor);
        regateEmbeds(view);
        expect(widgetKeys(computeEmbedDecorations(view.state))).toHaveLength(2);
        expect(editor.action(getMarkdown())).toBe(source);
    });
});

describe("the card and its metadata", () => {
    it("a link card should show the site and the readable URL until metadata arrives, then the title and description", () => {
        const card = renderEmbedCard({ kind: "linkCard", id: PAGE });
        expect(card.classList.contains("embed-card--link")).toBe(true);
        expect(card.querySelector(".embed-card__site")?.textContent).toBe("example.com");
        expect(card.querySelector(".embed-card__title")?.textContent).toBe("example.com/some/article");
        expect(card.querySelector(".embed-card__description")).toBeNull();
        expect(card.querySelector("img")).toBeNull();

        queueLinkCardResolution([PAGE]);
        const request = mockVscodeApi.postMessage.mock.calls
            .map(([m]) => m as { type: string; id: string; url: string })
            .find((m) => m.type === "resolveLinkCard");
        expect(request?.url).toBe(PAGE);
        handleLinkCardResult(request!.id, { title: "An <b>article</b>", description: "What it says." });
        expect(card.querySelector(".embed-card__title")?.textContent).toBe("An <b>article</b>");
        expect(card.querySelector(".embed-card__description")?.textContent).toBe("What it says.");
        // Literal text only: no markup interpreted.
        expect(card.querySelector(".embed-card__title b")).toBeNull();
    });

    it("a page should be asked once per session, and a null reply should stay cached as failed", () => {
        queueLinkCardResolution([PAGE, PAGE]);
        queueLinkCardResolution([PAGE]);
        const requests = mockVscodeApi.postMessage.mock.calls
            .map(([m]) => m as { type: string; id: string })
            .filter((m) => m.type === "resolveLinkCard");
        expect(requests).toHaveLength(1);
        handleLinkCardResult(requests[0]!.id, null);
        let seen: unknown = "unset";
        subscribeLinkCardMeta(PAGE, (card) => { seen = card; });
        expect(seen).toBeNull();
        queueLinkCardResolution([PAGE]);
        expect(mockVscodeApi.postMessage.mock.calls.filter(([m]) => (m as { type: string }).type === "resolveLinkCard")).toHaveLength(1);
    });
});

describe("the block menu row", () => {
    it("a lone link's menu should offer Show as Card, and the pick should card it without a document change", async () => {
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n`, [headingFoldPlugin, embedPlugin]);
        setBlockMenuContext({ getEditor: () => editor });
        const view = editorView(editor);
        regateEmbeds(view);
        const before = editor.action(getMarkdown());
        const marker = document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker")[1]!;
        marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const labels = () => Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item-label")).map((el) => el.textContent);
        expect(labels()).toContain("Show as Card");
        expect(labels()).not.toContain("Show as Link");
        const row = Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item"))
            .find((el) => el.querySelector(".block-menu-item-label")?.textContent === "Show as Card")!;
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(widgetKeys(computeEmbedDecorations(view.state))).toEqual([`embed:linkCard:${PAGE}:0`]);
        expect(editor.action(getMarkdown())).toBe(before);
        // Reopen: the row now reads the other way.
        marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        expect(labels()).toContain("Show as Link");
    });

    it("with the network off the row should not be offered (a dead switch)", async () => {
        i18n({ network: false });
        const editor = await makeCorpusEditor(`# T\n\n${PAGE}\n`, [headingFoldPlugin, embedPlugin]);
        setBlockMenuContext({ getEditor: () => editor });
        const marker = document.querySelectorAll<HTMLButtonElement>(".heading-fold-marker")[1]!;
        marker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        const labels = Array.from(document.querySelectorAll<HTMLElement>(".block-menu-item-label")).map((el) => el.textContent);
        expect(labels).not.toContain("Show as Card");
    });
});
