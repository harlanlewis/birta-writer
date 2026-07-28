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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getMarkdown } from "@milkdown/utils";
import { NodeSelection, TextSelection } from "../pm";
import type { DecorationSet } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { computeEmbedDecorations, embedPlugin, embedKeymapPlugin, regateEmbeds } from "../plugins/embed";
import { renderEmbedCard } from "../utils/embedCard";

const ID = "dQw4w9WgXcQ";
const LOOM = "0123456789abcdef0123456789abcdef";
const FKEY = "BAZsTPbh6W1r66Bdo9xkQp";

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

    it("the player iframe should be sandboxed with a minimal capability set", () => {
        // CSP frame-src pins WHICH host may load; sandbox pins what it may DO.
        // Pinned so a future provider can't quietly ship a fully-capable frame.
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        const iframe = card.querySelector<HTMLIFrameElement>("iframe")!;

        expect(iframe.getAttribute("sandbox")).toBe(
            "allow-scripts allow-same-origin allow-popups allow-presentation",
        );
        // clipboard-write was never needed for playback — keep it out.
        expect(iframe.getAttribute("allow")).not.toContain("clipboard-write");
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

describe("renderEmbedCard — branded facades (Loom, Figma)", () => {
    it("a Loom card should show the branded facade — no thumbnail, no network, no iframe", () => {
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        // The zero-fetch facade: a local mark instead of a fetched thumbnail.
        expect(card.querySelector("img")).toBeNull();
        expect(card.querySelector(".embed-card__brand")).not.toBeNull();
        expect(card.querySelector(".embed-card__brand-name")!.textContent).toBe("Loom");
        expect(card.querySelector("iframe")).toBeNull();
    });

    it("clicking play on a Loom card should build the loom.com/embed iframe", () => {
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        const iframe = card.querySelector<HTMLIFrameElement>("iframe");
        expect(iframe).not.toBeNull();
        expect(iframe!.src).toContain(`https://www.loom.com/embed/${LOOM}`);
        expect(iframe!.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    });

    it("a Figma card should carry the taller aspect and build the Embed Kit 2.0 iframe on click", () => {
        const card = renderEmbedCard({ kind: "figma", id: `design/${FKEY}` });
        // The interactive-canvas frame is taller than a video's 16:9.
        expect(card.style.getPropertyValue("--embed-aspect")).toBe("4 / 3");
        expect(card.querySelector("iframe")).toBeNull();

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();

        const iframe = card.querySelector<HTMLIFrameElement>("iframe");
        expect(iframe).not.toBeNull();
        expect(iframe!.src).toBe(`https://embed.figma.com/design/${FKEY}?embed-host=birta-writer`);
    });

    it("Figma's overlay should be an explicit labeled pill, not a glyph", () => {
        // A play triangle promises video playback; a design canvas loads a
        // preview — and a bare glyph (the old eye) promised nothing specific,
        // so the non-video surface states its verb in words. Video providers
        // keep the triangle.
        const figma = renderEmbedCard({ kind: "figma", id: `design/${FKEY}` });
        const loom = renderEmbedCard({ kind: "loom", id: LOOM });
        const figmaBtn = figma.querySelector<HTMLElement>(".embed-card__play")!;
        expect(figmaBtn.classList.contains("embed-card__play--label")).toBe(true);
        expect(figmaBtn.textContent).toBe("Load Figma preview");
        expect(figmaBtn.querySelector("svg")).toBeNull();
        expect(loom.querySelector(".embed-card__play")!.innerHTML).toContain("M8 5v14l11-7z");
    });

    it("a Vimeo card should show the branded facade and load the dnt player on click", () => {
        const card = renderEmbedCard({ kind: "vimeo", id: "1084537" });
        expect(card.querySelector("img")).toBeNull();
        expect(card.querySelector(".embed-card__brand-name")!.textContent).toBe("Vimeo");
        expect(card.querySelector("iframe")).toBeNull();

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        const iframe = card.querySelector<HTMLIFrameElement>("iframe")!;
        // dnt=1 (Vimeo's do-not-track) rides every player load. NO autoplay:
        // a webview's activation never delegates into a fresh cross-origin
        // iframe, so requested autoplay just blocks and spins — the provider's
        // own play button is the reliable gesture.
        expect(iframe.src).toBe("https://player.vimeo.com/video/1084537?dnt=1");
    });

    it("without a source URL the external button should fall back to the canonical page", async () => {
        const { mockVscodeApi } = await import("./setup");
        mockVscodeApi.postMessage.mockClear();
        const card = renderEmbedCard({ kind: "loom", id: LOOM });

        card.querySelector<HTMLButtonElement>(".embed-card__external")!.click();

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openUrl",
            url: `https://www.loom.com/share/${LOOM}`,
        });
    });
});

describe("renderEmbedCard — persistent controls, captions, and error states", () => {
    it("the external button should survive the play click", () => {
        // It used to live inside the replaced facade, so playing destroyed the
        // one guaranteed escape hatch (user report, 2026-07-27).
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        expect(card.querySelector("iframe")).not.toBeNull();
        expect(card.querySelector(".embed-card__external")).not.toBeNull();
    });

    it("stop should appear on play and restore the facade when clicked", () => {
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        const stop = card.querySelector<HTMLButtonElement>(".embed-card__stop")!;
        expect(stop.hidden).toBe(true);

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        expect(stop.hidden).toBe(false);

        stop.click();
        expect(card.querySelector("iframe")).toBeNull();
        expect(card.querySelector(".embed-card__brand")).not.toBeNull();
        expect(card.querySelector(".embed-card__play")).not.toBeNull();
        expect(stop.hidden).toBe(true);
    });

    it("a failed thumbnail should degrade to the branded facade, keeping play", () => {
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const thumb = card.querySelector<HTMLImageElement>(".embed-card__thumb")!;
        thumb.dispatchEvent(new Event("error"));
        expect(card.querySelector(".embed-card__thumb")).toBeNull();
        expect(card.querySelector(".embed-card__brand")).not.toBeNull();
        expect(card.querySelector(".embed-card__play")).not.toBeNull();
    });

    it("every player facade should carry a RESIDENT identity strip with the URL", () => {
        // No hover required — glanceable identity was the point (user
        // direction 2026-07-27; the previous hover-reveal on thumbnails hid
        // exactly the information the feature fetches).
        const source = `https://www.loom.com/share/${LOOM}`;
        const loom = renderEmbedCard({ kind: "loom", id: LOOM }, source);
        const loomUrl = loom.querySelector<HTMLElement>(".embed-card__meta-url")!;
        expect(loomUrl.textContent).toContain("loom.com/share/");
        expect(loomUrl.title).toBe(source);

        const yt = renderEmbedCard({ kind: "youtube", id: ID });
        const ytUrl = yt.querySelector<HTMLElement>(".embed-card__meta-url")!;
        // No source URL given: falls back to the canonical page.
        expect(ytUrl.textContent).toContain("youtube.com/watch");
        // The title row exists, empty until metadata resolves (hidden by :empty).
        expect(yt.querySelector(".embed-card__meta-title")!.textContent).toBe("");
    });

    it("clicking the facade (not just the button) should activate the player", () => {
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        expect(card.querySelector("iframe")).toBeNull();
        card.querySelector<HTMLElement>(".embed-card__stage")!.click();
        expect(card.querySelector("iframe")).not.toBeNull();
        expect(card.classList.contains("embed-card--playing")).toBe(true);
    });

    it("clicking the identity strip should NOT activate — it selects (bubbles to the host)", () => {
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        card.querySelector<HTMLElement>(".embed-card__meta")!.click();
        expect(card.querySelector("iframe")).toBeNull();
    });

    it("the controls should live OUTSIDE the frame — a player owns its own corners", () => {
        // Vimeo's fullscreen/PiP cluster sat exactly under our old overlay
        // controls; the collision recurs for arbitrary embeds, so our chrome
        // sits in a column beside the frame, never inside it.
        const card = renderEmbedCard({ kind: "youtube", id: ID });
        const controls = card.querySelector(".embed-card__controls")!;
        expect(card.querySelector(".embed-card__frame")!.contains(controls)).toBe(false);
        expect(card.classList.contains("embed-card--player")).toBe(true);
    });

    it("branded facades should pin the text-only name to the corner, clear of the control", () => {
        const card = renderEmbedCard({ kind: "figma", id: `design/${FKEY}` });
        const brand = card.querySelector<HTMLElement>(".embed-card__brand")!;
        // No invented logo glyphs; the service name is the identity.
        expect(brand.querySelector("svg")).toBeNull();
        expect(brand.querySelector(".embed-card__brand-name")!.textContent).toBe("Figma");
        // The name is a corner bug, a SIBLING of the centered activate control
        // — separate corners, so overlap is structurally impossible.
        const play = card.querySelector(".embed-card__play")!;
        expect(brand.contains(play)).toBe(false);
        expect(brand.parentElement).toBe(play.parentElement);
    });

    it("the identity strip should live BELOW the frame, outside it", () => {
        // The metadata stays useful while the player runs, so the strip is a
        // sibling under the frame — never an in-frame overlay the iframe
        // replaces or the provider's chrome fights.
        const card = renderEmbedCard({ kind: "loom", id: LOOM });
        const meta = card.querySelector(".embed-card__meta")!;
        expect(card.querySelector(".embed-card__frame")!.contains(meta)).toBe(false);
        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        // Still present (and un-hidden) while the player runs.
        expect(card.querySelector(".embed-card__meta")).not.toBeNull();
    });

    it("the sign-in hint should be a persistent clickable open-externally row", async () => {
        const { mockVscodeApi } = await import("./setup");
        mockVscodeApi.postMessage.mockClear();
        const source = `https://www.figma.com/design/${FKEY}/My-File`;
        const card = renderEmbedCard({ kind: "figma", id: `design/${FKEY}` }, source);
        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();

        const hint = card.querySelector<HTMLButtonElement>(".embed-card__hint")!;
        expect(hint.hidden).toBe(false);
        expect(hint.textContent).toContain("Open in Figma");
        hint.click();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openUrl", url: source });
    });

    it("host-supplied actions should render edit + show-as-link controls that invoke them", () => {
        const edit = vi.fn();
        const removePreview = vi.fn();
        const card = renderEmbedCard({ kind: "loom", id: LOOM }, undefined, { edit, removePreview });
        card.querySelector<HTMLButtonElement>(".embed-card__edit")!.click();
        expect(edit).toHaveBeenCalledOnce();
        card.querySelector<HTMLButtonElement>(".embed-card__aslink")!.click();
        expect(removePreview).toHaveBeenCalledOnce();
        // Without actions (no host, e.g. these DOM-only tests) the verbs are
        // simply absent rather than dead.
        const bare = renderEmbedCard({ kind: "loom", id: LOOM });
        expect(bare.querySelector(".embed-card__edit")).toBeNull();
    });

    it("the Figma sign-in hint should show only while the player is loaded", () => {
        const card = renderEmbedCard({ kind: "figma", id: `design/${FKEY}` });
        const hint = card.querySelector<HTMLElement>(".embed-card__hint")!;
        expect(hint.hidden).toBe(true);

        card.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        expect(hint.hidden).toBe(false);

        card.querySelector<HTMLButtonElement>(".embed-card__stop")!.click();
        expect(hint.hidden).toBe(true);
        // Video providers never show it — a blank video frame is an error, not
        // an auth wall.
        const loom = renderEmbedCard({ kind: "loom", id: LOOM });
        loom.querySelector<HTMLButtonElement>(".embed-card__play")!.click();
        expect(loom.querySelector<HTMLElement>(".embed-card__hint")!.hidden).toBe(true);
    });

    it("a resolved oEmbed title should fill the title row — as literal text only", async () => {
        const { queueEmbedMetaResolution, _resetEmbedMetaForTests } = await import("../embedMeta");
        const { mockVscodeApi } = await import("./setup");
        _resetEmbedMetaForTests();
        mockVscodeApi.postMessage.mockClear();

        const source = `https://www.loom.com/share/${LOOM}`;
        const card = renderEmbedCard({ kind: "loom", id: LOOM }, source);
        const title = card.querySelector<HTMLElement>(".embed-card__meta-title")!;
        const url = card.querySelector<HTMLElement>(".embed-card__meta-url")!;
        expect(title.textContent).toBe("");

        // The idle pass asks; the reply lands; the title row fills in place.
        queueEmbedMetaResolution([{ match: { kind: "loom", id: LOOM }, href: source }]);
        const request = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as { type: string; id: string })
            .find((m) => m.type === "resolveEmbedMeta")!;
        const { handleEmbedMetaResult } = await import("../embedMeta");
        // A hostile title renders as literal text (textContent, never innerHTML).
        handleEmbedMetaResult(request.id, `<img src=x onerror=alert(1)> Weekly sync`);
        expect(title.textContent).toBe("<img src=x onerror=alert(1)> Weekly sync");
        expect(title.querySelector("img")).toBeNull();
        // The URL row keeps the URL — both visible, no replacement.
        expect(url.textContent).toContain("loom.com/share/");
        expect(url.title).toBe(source);
        _resetEmbedMetaForTests();
    });

    it("readableUrl should strip scheme/www and middle-truncate long paths", async () => {
        const { readableUrl } = await import("../utils/embedCard");
        expect(readableUrl("https://www.loom.com/share/abc")).toBe("loom.com/share/abc");
        const long = readableUrl(`https://www.figma.com/design/${FKEY}/A-Very-Long-Design-File-Title-Indeed`, 40);
        expect(long.length).toBeLessThanOrEqual(40);
        expect(long).toContain("…");
        expect(long.startsWith("figma.com/")).toBe(true);
        // Not a URL at all: shown as-is rather than thrown on.
        expect(readableUrl("not a url")).toBe("not a url");
    });
});

describe("renderEmbedCard — the GitHub info card", () => {
    it("a repo card should be a frameless row with owner/repo and NO iframe path at all", () => {
        const card = renderEmbedCard({ kind: "github", id: "harlanlewis/birta-writer" });
        expect(card.classList.contains("embed-card--info")).toBe(true);
        expect(card.dataset["embedKind"]).toBe("github");
        // No player anatomy whatsoever — this card can never make a request.
        expect(card.querySelector(".embed-card__frame")).toBeNull();
        expect(card.querySelector(".embed-card__play")).toBeNull();
        expect(card.querySelector("iframe")).toBeNull();
        expect(card.querySelector("img")).toBeNull();
        expect(card.querySelector(".embed-card__title")!.textContent).toBe("harlanlewis/birta-writer");
        // A bare repo has no detail line.
        expect(card.querySelector(".embed-card__detail")).toBeNull();
    });

    it("PR, issue, and file cards should carry their detail line", () => {
        const pull = renderEmbedCard({ kind: "github", id: "o/r/pull/42" });
        expect(pull.querySelector(".embed-card__detail")!.textContent).toBe("Pull request #42");

        const issue = renderEmbedCard({ kind: "github", id: "o/r/issues/7" });
        expect(issue.querySelector(".embed-card__detail")!.textContent).toBe("Issue #7");

        const blob = renderEmbedCard({ kind: "github", id: "o/r/blob/main/src/deep/file.ts" });
        expect(blob.querySelector(".embed-card__detail")!.textContent).toBe("src/deep/file.ts");
    });

    it("the external button should open the page through the extension", async () => {
        const { mockVscodeApi } = await import("./setup");
        mockVscodeApi.postMessage.mockClear();
        const source = "https://github.com/o/r/pull/42";
        const card = renderEmbedCard({ kind: "github", id: "o/r/pull/42" }, source);

        const external = card.querySelector<HTMLButtonElement>(".embed-card__external")!;
        const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        external.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true); // caret-safety contract holds here too

        external.click();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openUrl", url: source });
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

    it("an edit ABOVE an embed should leave every widget key unchanged", async () => {
        // The key must be position-independent: ProseMirror reuses widget DOM
        // only for a matching key, so a key that shifts with the document
        // tears down (and rebuilds) every card below any edit — including a
        // playing iframe (found 2026-07-27: typing one character above a
        // playing video reset it to its facade).
        const editor = await makeCorpusEditor(
            `# Title\n\nhttps://youtu.be/${ID}\n\nhttps://www.loom.com/share/${LOOM}\n`,
        );
        const view = editorView(editor);
        caretTo(view, 1);
        const keysOf = (): string[] =>
            computeEmbedDecorations(view.state)
                .find()
                .filter((d) => d.from === d.to)
                .map((d) => (d.spec as { key: string }).key)
                .sort();
        const before = keysOf();
        expect(before).toHaveLength(2);
        // Type into the heading, above both embeds: positions shift, keys must not.
        view.dispatch(view.state.tr.insertText("x", 1));
        expect(keysOf()).toEqual(before);
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
        // The master network switch gates network-using providers: with it off
        // (the default), a YouTube card — which fetches a thumbnail — never
        // renders even though embedsEnabled defaults on (MAR-179).
        window.__i18n = { translations: {}, network: false, embedsEnabled: true } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        const set = computeEmbedDecorations(view.state);
        expect(decoCounts(set)).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("a GitHub link should render its card even with the network switch OFF", async () => {
        // The render ladder's Rung 0 (MAR-186): the switch gates REQUESTS, and
        // the GitHub info card makes none — built from URL parts alone, it
        // renders offline. Only network-using providers wait for the switch.
        window.__i18n = { translations: {}, network: false, embedsEnabled: true } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(
            `# Title\n\nhttps://github.com/harlanlewis/birta-writer\n\nhttps://youtu.be/${ID}\n`,
        );
        const view = editorView(editor);
        caretTo(view, 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        // Exactly the GitHub paragraph decorates; the YouTube one stays dark.
        expect(counts).toEqual({ nodes: 1, widgets: 1 });
        await editor.destroy();
    });

    it("embedsEnabled=false should silence the no-network cards too", async () => {
        // The FEATURE flag is the one switch that turns cards off entirely.
        window.__i18n = { translations: {}, network: false, embedsEnabled: false } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://github.com/owner/repo\n`);
        const view = editorView(editor);
        caretTo(view, 1);
        expect(decoCounts(computeEmbedDecorations(view.state))).toEqual({ nodes: 0, widgets: 0 });
        await editor.destroy();
    });

    it("every provider kind should decorate a bare link on its own line", async () => {
        const editor = await makeCorpusEditor(
            [
                "# Title",
                "",
                `https://youtu.be/${ID}`,
                "",
                `https://www.loom.com/share/${LOOM}`,
                "",
                `https://www.figma.com/design/${FKEY}/My-File`,
                "",
                "https://github.com/owner/repo/pull/42",
                "",
            ].join("\n"),
        );
        const view = editorView(editor);
        caretTo(view, 1);
        const counts = decoCounts(computeEmbedDecorations(view.state));
        expect(counts).toEqual({ nodes: 4, widgets: 4 });
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

    it("reveal-on-caret should work through the cached-match path (selection-only transactions)", async () => {
        // The plugin walks + recognizes only on doc changes; a selection-only
        // transaction re-filters cached matches (no walk, no URL parsing).
        // This drives that path end-to-end through real dispatches.
        window.__i18n = { translations: {}, network: true } as unknown as typeof window.__i18n;
        const editor = await makeCorpusEditor(`# Title\n\nhttps://youtu.be/${ID}\n`, [embedPlugin]);
        const view = editorView(editor);
        caretTo(view, 1);
        regateEmbeds(view); // arm + initial walk
        expect(pluginDecoCount(view)).toBeGreaterThan(0);

        // Caret INTO the embed paragraph: selection-only — card must drop.
        caretTo(view, view.state.doc.content.size - 1);
        expect(pluginDecoCount(view)).toBe(0);

        // Caret back out: selection-only — card must return.
        caretTo(view, 1);
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

describe("embed selection + keyboard model (MAR-187)", () => {
    /** Compose the plugin pair, arm the pass, and hand back the view. */
    async function makeSelectableEditor(source: string) {
        const editor = await makeCorpusEditor(source, [embedPlugin, embedKeymapPlugin]);
        const view = editorView(editor);
        regateEmbeds(view);
        return { editor, view };
    }

    /** Run the composed keymaps for one key, as the DOM event path would. */
    function sendKey(view: ReturnType<typeof editorView>, key: string): boolean {
        return view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key }))) ?? false;
    }

    /** The embed paragraph's start position (the doc's second top-level child). */
    function embedFrom(view: ReturnType<typeof editorView>): number {
        return view.state.doc.child(0).nodeSize;
    }

    const flushPalette = () => new Promise((r) => setTimeout(r, 20));

    afterEach(async () => {
        // The palette is a body-level singleton; close it between tests. (The
        // suite-level afterEach clears document.body; build() re-attaches.)
        const mod = await import("../components/embedPalette");
        mod.hideEmbedPalette();
    });

    it("a NodeSelection covering the embed should keep the card and mark it selected", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));

        const set = computeEmbedDecorations(view.state);
        const node = set.find().find((d) => d.from < d.to);
        expect(node).toBeDefined();
        // Selected: ring class present, card widget still there (a plain
        // overlapping selection would have dropped both — the reveal mode).
        expect((node!.spec as { class?: string }).class ?? (node! as unknown as { type: { attrs: { class: string } } }).type.attrs.class).toContain("embed-host--selected");
        expect(set.find().filter((d) => d.from === d.to)).toHaveLength(1);
        await editor.destroy();
    });

    it("ArrowRight at the end of the block before an embed should select the card", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        // Caret at the very end of the heading text.
        caretTo(view, view.state.doc.child(0).nodeSize - 1);

        expect(sendKey(view, "ArrowRight")).toBe(true);
        const sel = view.state.selection;
        expect(sel instanceof NodeSelection).toBe(true);
        expect(sel.from).toBe(embedFrom(view));
        await editor.destroy();
    });

    it("ArrowRight from a selected card should move the caret into the next block", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n\nAfter.\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));

        expect(sendKey(view, "ArrowRight")).toBe(true);
        const sel = view.state.selection;
        expect(sel.empty).toBe(true);
        expect(view.state.doc.resolve(sel.from).parent.textContent).toBe("After.");
        await editor.destroy();
    });

    it("sequential embeds should each be their own arrow stop", async () => {
        const { editor, view } = await makeSelectableEditor(
            `# Title\n\nhttps://youtu.be/${ID}\n\nhttps://www.loom.com/share/${LOOM}\n`,
        );
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));

        expect(sendKey(view, "ArrowRight")).toBe(true);
        const sel = view.state.selection;
        expect(sel instanceof NodeSelection).toBe(true);
        // The second embed starts where the first ends.
        expect(sel.from).toBe(embedFrom(view) + view.state.doc.child(1).nodeSize);
        await editor.destroy();
    });

    it("ArrowLeft at the start of the block after an embed should select the card", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n\nAfter.\n`);
        const afterStart = embedFrom(view) + view.state.doc.child(1).nodeSize + 1;
        caretTo(view, afterStart);

        expect(sendKey(view, "ArrowLeft")).toBe(true);
        expect(view.state.selection instanceof NodeSelection).toBe(true);
        expect(view.state.selection.from).toBe(embedFrom(view));
        await editor.destroy();
    });

    it("Backspace after an embed should SELECT it first, and delete on the second press", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n\nAfter.\n`);
        const afterStart = embedFrom(view) + view.state.doc.child(1).nodeSize + 1;
        caretTo(view, afterStart);
        const docBefore = view.state.doc;

        // First press: selection only — the document is untouched (the old
        // behavior merged the hidden URL into "After." as glued autolink text).
        expect(sendKey(view, "Backspace")).toBe(true);
        expect(view.state.doc.eq(docBefore)).toBe(true);
        expect(view.state.selection instanceof NodeSelection).toBe(true);

        // Second press: the embed paragraph is gone; the neighbours survive.
        expect(sendKey(view, "Backspace")).toBe(true);
        const markdown = editor.action(getMarkdown());
        expect(markdown).not.toContain("youtu.be");
        expect(markdown).toContain("After.");
        await editor.destroy();
    });

    it("Space on a selected card should toggle play and stop", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));
        // The card widget renders asynchronously (lazy chunk) — wait for it.
        await vi.waitFor(() => {
            if (!view.dom.querySelector(".embed-card__play")) { throw new Error("card not ready"); }
        });

        expect(sendKey(view, " ")).toBe(true);
        expect(view.dom.querySelector(".embed-card iframe")).not.toBeNull();

        expect(sendKey(view, " ")).toBe(true);
        expect(view.dom.querySelector(".embed-card iframe")).toBeNull();
        expect(view.dom.querySelector(".embed-card__play")).not.toBeNull();
        await editor.destroy();
    });

    it("the card's show-as-text-link control should convert the embed in place", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        await vi.waitFor(() => {
            if (!view.dom.querySelector(".embed-card__aslink")) { throw new Error("card not ready"); }
        });
        view.dom.querySelector<HTMLButtonElement>(".embed-card__aslink")!.click();
        await vi.waitFor(() => {
            const markdown = editor.action(getMarkdown());
            if (!markdown.includes(`[youtu.be/${ID}](https://youtu.be/${ID})`)) {
                throw new Error("not converted yet");
            }
        });
        expect(computeEmbedDecorations(view.state).find()).toHaveLength(0);
        await editor.destroy();
    });

    it("the card's edit control should TOGGLE the palette — open focused, close on re-press", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        await vi.waitFor(() => {
            if (!view.dom.querySelector(".embed-card__edit")) { throw new Error("card not ready"); }
        });
        const editBtn = view.dom.querySelector<HTMLButtonElement>(".embed-card__edit")!;
        editBtn.click();
        await flushPalette();
        expect(view.state.selection instanceof NodeSelection).toBe(true);
        const palette = document.querySelector<HTMLElement>(".embed-palette")!;
        const input = palette.querySelector<HTMLInputElement>(".embed-palette__url")!;
        expect(palette.classList.contains("embed-palette--visible")).toBe(true);
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe(`https://youtu.be/${ID}`);

        // Second press closes what the first opened (an open-only control left
        // no way back but Escape).
        editBtn.click();
        await flushPalette();
        expect(palette.classList.contains("embed-palette--visible")).toBe(false);
        await editor.destroy();
    });

    it("Enter on a selected card should open the palette with the URL editable", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));

        expect(sendKey(view, "Enter")).toBe(true);
        await flushPalette();
        const palette = document.querySelector<HTMLElement>(".embed-palette");
        expect(palette).not.toBeNull();
        expect(palette!.classList.contains("embed-palette--visible")).toBe(true);
        const input = palette!.querySelector<HTMLInputElement>(".embed-palette__url")!;
        expect(input.value).toBe(`https://youtu.be/${ID}`);
        expect(document.activeElement).toBe(input);
        await editor.destroy();
    });

    it("applying a URL edit in the palette should rewrite the bare link in one step", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));
        sendKey(view, "Enter");
        await flushPalette();

        const input = document.querySelector<HTMLInputElement>(".embed-palette__url")!;
        const newUrl = "https://youtu.be/aaaaaaaaaaa";
        input.value = newUrl;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        const markdown = editor.action(getMarkdown());
        expect(markdown).toContain(newUrl);
        expect(markdown).not.toContain(ID);
        // The rewritten paragraph is still a bare link — still a card — and
        // stays selected under the palette.
        expect(view.state.selection instanceof NodeSelection).toBe(true);
        await editor.destroy();
    });

    it("Show as text link should convert the card to a labeled link (de-carded)", async () => {
        const { editor, view } = await makeSelectableEditor(`# Title\n\nhttps://youtu.be/${ID}\n`);
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, embedFrom(view))));
        sendKey(view, "Enter");
        await flushPalette();

        const asLink = document.querySelectorAll<HTMLButtonElement>(".embed-palette .ui-btn")[2]!;
        asLink.click();

        const markdown = editor.action(getMarkdown());
        // A labeled [text](url): text ≠ href, so the paragraph no longer cards.
        expect(markdown).toContain(`[youtu.be/${ID}](https://youtu.be/${ID})`);
        expect(computeEmbedDecorations(view.state).find()).toHaveLength(0);
        await editor.destroy();
    });
});

describe("serialization is untouched by the embed decorations (round-trip proof)", () => {
    it("the embed plugin should add nothing to the serialized markdown", async () => {
        const source = [
            "# Title",
            "",
            `https://www.youtube.com/watch?v=${ID}`,
            "",
            `https://www.loom.com/share/${LOOM}`,
            "",
            `https://www.figma.com/design/${FKEY}/My-File`,
            "",
            "https://github.com/owner/repo/pull/42",
            "",
        ].join("\n");
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
