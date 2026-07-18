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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { TextSelection } from "../pm";
import type { DecorationSet } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { computeEmbedDecorations, embedPlugin, regateEmbeds } from "../plugins/embed";
import { renderEmbedCard } from "../utils/embedCard";

const ID = "dQw4w9WgXcQ";

beforeEach(() => {
    // Embeds are gated on the master network switch (MAR-179, offline by
    // default) AND the feature key. Turn the master ON for the trigger-condition
    // tests; the network-off case flips it back explicitly.
    window.__i18n = { translations: {}, network: true } as unknown as typeof window.__i18n;
});

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

    it("the play button should swallow mousedown so the caret never moves", () => {
        // Defensive, and pinned so it stays: the card rides a widget decoration
        // inside the contenteditable root, and its buttons must own their own
        // clicks rather than depend on the browser declining to put a caret in
        // a contenteditable="false" subtree. Same contract as every other
        // clickable widget here (ui/foldEllipsis.ts).
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const play = card.querySelector<HTMLButtonElement>(".embed-card__play")!;

        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        play.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
    });

    it("the external-open button should swallow mousedown too", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const external = card.querySelector<HTMLButtonElement>(".embed-card__external")!;

        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        external.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
    });

    it("Enter on the focused play button should activate it, not type", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const play = card.querySelector<HTMLButtonElement>(".embed-card__play")!;

        const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
        play.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(card.querySelector("iframe")).not.toBeNull();
    });

    it("should build the nocookie player iframe only when play is clicked", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        expect(card.querySelector("iframe")).toBeNull();

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();

        const iframe = card.querySelector<HTMLIFrameElement>("iframe");
        expect(iframe).not.toBeNull();
        expect(iframe!.src).toContain("https://www.youtube-nocookie.com/embed/" + ID);
        // Error-153 mitigation: send what referrer the environment allows.
        expect(iframe!.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    });

    it("the Open-on-YouTube button should route the SOURCE url through the extension", async () => {
        const { mockVscodeApi } = await import("./setup");
        mockVscodeApi.postMessage.mockClear();
        const source = `https://youtu.be/${ID}?t=42`;
        const card = renderEmbedCard({ kind: "youtube", id: ID }, source);

        card.querySelector<HTMLButtonElement>(".embed-card__external")!.click();

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openUrl", url: source });
        // No iframe was built — external open is not playback.
        expect(card.querySelector("iframe")).toBeNull();
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

    it("two bare links to the SAME video should get DISTINCT widget keys", async () => {
        // Same-key widgets are treated as one by ProseMirror's redraw
        // reconciliation, which can skip or misplace DOM for the second card.
        const editor = await makeCorpusEditor(
            `# Title\n\nhttps://youtu.be/${ID}\n\nhttps://www.youtube.com/watch?v=${ID}\n`,
        );
        const view = editorView(editor);
        caretTo(view, 1);
        const widgets = computeEmbedDecorations(view.state)
            .find()
            .filter((d) => d.from === d.to);
        expect(widgets).toHaveLength(2);
        const keys = widgets.map((d) => (d.spec as { key: string }).key);
        expect(new Set(keys).size).toBe(2);
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
        window.__i18n = { translations: {}, network: true, embedsEnabled: false } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const set = computeEmbedDecorations(view.state);
        expect(decoCounts(set)).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("offline by default (network=false) should render nothing even with the feature on", async () => {
        // The master network switch gates embeds: with it off (the default),
        // no card renders even though embedsEnabled defaults on (MAR-179).
        window.__i18n = { translations: {}, network: false, embedsEnabled: true } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const set = computeEmbedDecorations(view.state);
        expect(decoCounts(set)).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });
});

describe("regateEmbeds — a gate flip takes effect without a doc edit", () => {
    /** The plugin's live decoration set, as the editor view would render it. */
    function pluginDecoCount(view: ReturnType<typeof editorView>): number {
        let total = 0;
        view.someProp("decorations", (f) => {
            const set = f.call(view.state.plugins.find((p) => p.props.decorations) ?? {}, view.state);
            total += set && "find" in set ? (set as DecorationSet).find().length : 0;
            return false;
        });
        return total;
    }

    it("turning embeds ON should render cards in place, with no reopen", async () => {
        // Gated OFF at creation: the plugin composes anyway (it is inert), which
        // is what makes a later flip possible at all.
        window.__i18n = { translations: {}, network: false } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`, [embedPlugin]);
        const view = editorView(editor);
        caretTo(view, 1);
        expect(pluginDecoCount(view)).toBe(0);

        // What the networkStateChanged handler does: flip the flag, then regate.
        window.__i18n!.network = true;
        regateEmbeds(view);

        expect(pluginDecoCount(view)).toBeGreaterThan(0);
        await editor.destroy();
    });

    it("turning embeds OFF should drop the cards immediately, not on the next click", async () => {
        window.__i18n = { translations: {}, network: true } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`, [embedPlugin]);
        const view = editorView(editor);
        caretTo(view, 1);
        regateEmbeds(view); // arm the first pass without waiting on idle
        expect(pluginDecoCount(view)).toBeGreaterThan(0);

        window.__i18n!.network = false;
        regateEmbeds(view);

        expect(pluginDecoCount(view)).toBe(0);
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
