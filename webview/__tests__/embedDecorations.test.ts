/**
 * Embed decoration + facade behavior (MAR-56), against a REAL Milkdown document
 * (real gfm autolink, so the bare-link paragraphs carry genuine `link` marks).
 *
 * The invariants under test:
 *  - A recognized bare-link paragraph gets a host node decoration + a card
 *    widget; the card itself is a facade — a thumbnail, NO <iframe> until the
 *    play button is clicked.
 *  - Reveal-on-caret: the paragraph the selection is in gets NO decorations, so
 *    the raw link shows and stays editable.
 *  - A titled `[label](url)` link, a URL mid-prose, and a non-provider bare link
 *    produce NO card.
 *  - Disabled (`__i18n.embedsEnabled=false`) produces nothing.
 *  - Decorations never touch state.doc: serialization with the plugin active is
 *    byte-identical to the source (the round-trip proof).
 */
import { describe, it, expect, afterEach } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { DecorationSet } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { computeEmbedDecorations, embedPlugin } from "../plugins/embed";
import { renderEmbedCard } from "../utils/embedCard";

const ID = "dQw4w9WgXcQ";

afterEach(() => {
    delete window.__i18n;
    document.body.innerHTML = "";
});

/** [node decorations (from<to), widget decorations (from===to)] counts. */
function decoCounts(set: DecorationSet): { nodes: number; widgets: number } {
    const all = set.find();
    return {
        nodes: all.filter((d) => d.from < d.to).length,
        widgets: all.filter((d) => d.from === d.to).length,
    };
}

/** Move the caret to a document position and return the fresh state. */
function caretTo(view: ReturnType<typeof editorView>, pos: number): void {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

describe("renderEmbedCard — the click-to-load facade", () => {
    it("should render a thumbnail with no iframe before the play button is clicked", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const thumb = card.querySelector<HTMLImageElement>(".embed-card__thumb");
        expect(thumb).not.toBeNull();
        expect(thumb!.src).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
        expect(thumb!.loading).toBe("lazy");
        // The whole point of the facade: no player until asked for.
        expect(card.querySelector("iframe")).toBeNull();
    });

    it("should build the nocookie player iframe only when play is clicked", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        expect(card.querySelector("iframe")).toBeNull();

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();

        const iframe = card.querySelector<HTMLIFrameElement>("iframe");
        expect(iframe).not.toBeNull();
        expect(iframe!.src).toContain("https://www.youtube-nocookie.com/embed/" + ID);
    });
});

describe("computeEmbedDecorations — trigger conditions", () => {
    it("a bare YouTube link on its own line should get a host node deco + a card widget", async () => {
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        caretTo(view, 1); // caret in the heading, away from the embed
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 1, widgets: 1 });
        await editor.destroy();
    });

    it("the paragraph the caret is in should reveal the raw link (no decorations)", async () => {
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        // Put the caret inside the embed paragraph (last text position).
        caretTo(view, view.state.doc.content.size - 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("a titled [label](url) link should NOT render a card", async () => {
        const editor = await makeCorpusEditor(`# Title\n\n[watch this](https://youtu.be/${ID})\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("a YouTube URL inside a sentence should NOT render a card", async () => {
        const editor = await makeCorpusEditor(`# Title\n\nWatch https://youtu.be/${ID} today.\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("a bare non-provider link should NOT render a card", async () => {
        const editor = await makeCorpusEditor(`# Title\n\nhttps://example.com/page\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("disabled (embedsEnabled=false) should render nothing", async () => {
        window.__i18n = { translations: {}, embedsEnabled: false } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const set = computeEmbedDecorations(view.state);
        expect(decoCounts(set)).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });
});

describe("serialization is untouched by the embed decorations (round-trip proof)", () => {
    it("the embed plugin should add nothing to the serialized markdown", async () => {
        const source = `# Title\n\nhttps://www.youtube.com/watch?v=${ID}\n`;
        // Decorations live in props.decorations, never in state.doc, so getMarkdown
        // cannot see them: the serialization with the plugin active is identical to
        // the serialization without it (whatever the serializer's own autolink
        // formatting is — the full round-trip is pinned in roundTripCorpus.test.ts).
        const withPlugin = await makeCorpusEditor(source, [embedPlugin]);
        const withoutPlugin = await makeCorpusEditor(source);
        expect(withPlugin.action(getMarkdown())).toBe(withoutPlugin.action(getMarkdown()));
        await withPlugin.destroy();
        await withoutPlugin.destroy();
    });
});
