/**
 * The per-provider embed roster at the decoration pass (MAR-186): switching one
 * provider off must stop ITS cards and leave every other provider alone.
 *
 * Swept over every provider rather than sampled, because the bug this guards
 * is per-row: a provider whose gate is missing looks identical to one whose
 * gate works until you try that provider specifically. The sweep asserts its
 * own coverage and names what it could not reach — a sweep that enumerated
 * nothing passes, and this repo has shipped that (MAR-141).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TextSelection } from "../pm";
import { makeCorpusEditor, editorView } from "./helpers/moveFuzz";
import { collectEmbeds } from "../plugins/embed";
import { EMBED_KINDS, canonicalEmbedUrl, type EmbedKind } from "../../shared/embedProviders";

/** A real id per provider, so each kind becomes a real bare link. */
const IDS: Record<EmbedKind, string> = {
    youtube: "dQw4w9WgXcQ",
    vimeo: "1084537",
    loom: "0123456789abcdef0123456789abcdef",
    figma: "design/AbCdEf123456",
    github: "owner/repo",
    googledrive: "1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    googledocs: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googleslides: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlesheets: "2PACX-1vAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    googlefile: "document/1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
    miro: "uXjVO5X2CWo=",
    linear: "birta/issue/MAR-186/embed-provider-roadmap",
    codepen: "chriscoyier/AbCdEf",
    codesandbox: "new-react-sandbox-abc123",
    stackblitz: "vitejs-vite-abc123",
};

/** The roster map the webview would have been given. */
function setRoster(providers: Record<string, boolean> | undefined): void {
    window.__i18n = {
        translations: {},
        network: true,
        embedProviders: providers,
    } as unknown as typeof window.__i18n;
}

beforeEach(() => {
    setRoster(undefined);
});

afterEach(() => {
    delete window.__i18n;
    document.body.innerHTML = "";
});

// 15 providers, one real Milkdown editor each. Measured cost is dominated by
// editor construction, not by the assertions; a per-describe timeout keeps the
// project default from being raised for everyone else.
describe("the per-provider roster at collectEmbeds", { timeout: 60_000 }, () => {
    it("switching a provider off should stop its cards and no others", async () => {
        const covered: EmbedKind[] = [];
        const unreachable: string[] = [];

        for (const kind of EMBED_KINDS) {
            const url = canonicalEmbedUrl(kind, IDS[kind]);
            const editor = await makeCorpusEditor(`# Title\n\n${url}\n`);
            const view = editorView(editor);
            // Caret in the heading: the embed's own paragraph would reveal the
            // raw link and produce nothing, which would read as a pass.
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));

            // Baseline FIRST: a kind whose URL does not card here would make
            // the off-case trivially true. Those are reported, never skipped.
            setRoster(undefined);
            const baseline = collectEmbeds(view.state);
            if (baseline.length !== 1 || baseline[0].match.kind !== kind) {
                unreachable.push(
                    `${kind}: baseline produced ${baseline.length} embed(s)` +
                        `${baseline[0] ? ` of kind ${baseline[0].match.kind}` : ""}`,
                );
                await editor.destroy();
                continue;
            }
            covered.push(kind);

            // This provider off — its card must go.
            setRoster({ [kind]: false });
            expect(collectEmbeds(view.state), `${kind} switched off still carded`).toHaveLength(0);

            // A DIFFERENT provider off — this one must be untouched. Without
            // this half, a gate that switched off every provider at once would
            // pass the assertion above.
            const other = EMBED_KINDS.find((k) => k !== kind)!;
            setRoster({ [other]: false });
            expect(
                collectEmbeds(view.state),
                `${kind} lost its card when ${other} was switched off`,
            ).toHaveLength(1);

            // An explicit true is the same as silence.
            setRoster({ [kind]: true });
            expect(collectEmbeds(view.state)).toHaveLength(1);

            await editor.destroy();
        }

        expect(unreachable, "providers the sweep could not build a card for").toEqual([]);
        expect(covered).toHaveLength(EMBED_KINDS.length);
        expect(covered.length).toBeGreaterThanOrEqual(15);
    });

    it("a document of many providers should lose only the one switched off", async () => {
        // The single-link cases cannot see a gate that keys off document
        // contents rather than the row it is testing.
        const kinds: EmbedKind[] = ["youtube", "github", "figma", "linear"];
        const body = kinds.map((k) => canonicalEmbedUrl(k, IDS[k])).join("\n\n");
        const editor = await makeCorpusEditor(`# Title\n\n${body}\n`);
        const view = editorView(editor);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));

        setRoster(undefined);
        expect(collectEmbeds(view.state).map((e) => e.match.kind)).toEqual(kinds);

        setRoster({ figma: false });
        expect(collectEmbeds(view.state).map((e) => e.match.kind)).toEqual(
            kinds.filter((k) => k !== "figma"),
        );

        await editor.destroy();
    });
});
