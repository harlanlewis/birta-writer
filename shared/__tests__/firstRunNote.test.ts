/**
 * The first-run tour's promises, checked against the code that has to keep
 * them.
 *
 * The tour is a Swift string and everything it claims is TypeScript, so
 * nothing relates the two on its own. If a recognizer stops matching one of
 * its links, nothing fails: the link renders as a link, the sentence above it
 * becomes false, and the first thing a new user does is watch the product not
 * do what its own welcome note said it would.
 *
 * Whether a card RESOLVES is a network fact and no test here can settle it.
 * What can be settled is that the tour is not inventing URLs of its own: its
 * links are the same ones `samples/content-inventory.md` demonstrates, which
 * makes that file the single list of known-live embed URLs. A link retired
 * from the sample takes this note red rather than leaving a new user's first
 * document pointing at nothing, which is what a placeholder did.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recognizeEmbed, type EmbedKind } from "../embedProviders";
import { providerCardGateOpen } from "../../webview/utils/embedProviders";
import { JOT_PRODUCT_NAME } from "../product";

const root = path.resolve(__dirname, "../..");
const swift = readFileSync(
    path.join(root, "jot/Sources/BirtaJotCore/FirstRunNote.swift"), "utf8");
const sample = readFileSync(path.join(root, "samples/content-inventory.md"), "utf8");

/** The tour's markdown: the one multi-line literal in that file. */
const markdown = (): string => {
    const body = swift.match(/public static let markdown = """\n([\s\S]*?)\n {4}"""/)?.[1];
    expect(body, "the tour's markdown should still be readable here").toBeTruthy();
    // Swift strips the closing delimiter's indentation from every line.
    return body!.split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
};

/**
 * Run `body` with the webview's config blob set to `config`.
 *
 * `providerCardGateOpen` is webview code and reads `window.__i18n`, which does
 * not exist in this project's node environment; in a webview `window` IS the
 * global, so standing one up here is the same object under the name the code
 * asks for rather than a stub of it.
 */
function withConfig(config: Record<string, unknown>, body: () => void): void {
    const g = globalThis as { window?: unknown; __i18n?: unknown };
    const hadWindow = "window" in g;
    const previous = g.__i18n;
    g.window ??= globalThis;
    g.__i18n = config;
    try {
        body();
    } finally {
        g.__i18n = previous;
        if (!hadWindow) { delete g.window; }
    }
}

/** Bare links on a line of their own, which is what the embed plugin claims. */
const bareLinks = (text: string): string[] =>
    text.split("\n").map((l) => l.trim()).filter((l) => /^https?:\/\/\S+$/.test(l));

describe("the first-run tour", () => {
    it("every bare link in the tour should be recognized as an embed", () => {
        const links = bareLinks(markdown());
        // A tour that lost its links would pass a per-link loop over nothing.
        expect(links.length, "the tour should still print bare links").toBeGreaterThanOrEqual(2);
        for (const link of links) {
            expect(recognizeEmbed(link), `no provider claims ${link}`).not.toBeNull();
        }
    });

    it("the recognizer should be able to refuse, so the check above discriminates", () => {
        // A per-link loop over a predicate that says yes to everything passes
        // on any prose at all. These are the two shapes a mangled tour link
        // would actually take: a provider host with an id the extractor
        // rejects, and a host no provider claims.
        expect(recognizeEmbed("https://www.loom.com/share/notahexid")).toBeNull();
        expect(recognizeEmbed("https://example.com/nothing/here")).toBeNull();
    });

    it("every bare link in the tour should be one the sample corpus also carries", () => {
        // The half a shape check cannot reach. A placeholder is well-formed by
        // construction, so "a provider claims it" is satisfied by a URL with
        // nothing behind it, which is how the tour first shipped
        // (`loom.com/share/deadbeef…`, and a Figma key of
        // `BirtaWriterTourPlaceholder`). Tying the tour to the sample means
        // the two places that print an embed URL cannot disagree about which
        // URLs are live, and there is one file to fix when one dies.
        const links = bareLinks(markdown());
        expect(links.length).toBeGreaterThanOrEqual(2);
        for (const link of links) {
            expect(sample.includes(link),
                `${link} is not in samples/content-inventory.md, so nothing records that it resolves`)
                .toBe(true);
        }
    });

    it("the tour should demonstrate the two providers it names in its prose", () => {
        const text = markdown();
        const kinds = new Set(bareLinks(text).map((l) => recognizeEmbed(l)?.kind));
        // Named in the sentence above the links, so the sentence and the
        // demonstration cannot drift apart without this failing.
        for (const [kind, prose] of [["loom", "Loom"], ["figma", "Figma"]] as const) {
            expect(kinds, `the tour should carry a ${kind} link`).toContain(kind as EmbedKind);
            expect(text, `the tour's prose should still name ${prose}`).toContain(prose);
        }
        // Two different providers, not one drawn twice: the section's claim is
        // about links in general, so one card kind would show it once.
        expect(kinds.size, "the tour's links should not all be the same provider").toBeGreaterThan(1);
    });

    it("the tour's links should be plain on a first run, which is what its callout says", () => {
        // The claim that shipped wrong. The section used to open "A link alone
        // on its own line becomes a card" and close with "Those cards are
        // closed, and they stay closed", and neither link is a card at all on a
        // first run: both providers need the network, the switch ships off, and
        // `providerCardGateOpen` refuses them. So a new user read two sentences
        // about cards while looking at two blue links.
        //
        // Asked of the GATE rather than of the words, because the gate is what
        // decides. If embeds ever ship on, this fires and the sentence gets
        // re-read; the words alone could not have told anyone.
        const links = bareLinks(markdown());
        expect(links.length).toBeGreaterThanOrEqual(2);

        // Exactly the defaults: `network` absent reads false, and Jot ties
        // `embedsEnabled` to it, so this is the more generous of the two
        // surfaces and still refuses.
        let asked = 0;
        withConfig({ embedsEnabled: true }, () => {
            for (const link of links) {
                const match = recognizeEmbed(link);
                expect(match, `no provider claims ${link}`).not.toBeNull();
                asked += 1;
                expect(
                    providerCardGateOpen(match!),
                    `${link} cards with the network off, so the tour's callout is now wrong`,
                ).toBe(false);
            }
        });
        expect(asked, "the gate was never asked").toBe(links.length);

        // And the gate can say yes, or the loop above is agreeing with a
        // predicate that refuses everything and the tour could claim anything
        // at all.
        withConfig({ embedsEnabled: true, network: true }, () => {
            for (const link of links) {
                expect(
                    providerCardGateOpen(recognizeEmbed(link)!),
                    `${link} never cards, so the tour is demonstrating nothing`,
                ).toBe(true);
            }
        });
    });

    it("the tour should not promise a card the reader is not looking at", () => {
        // The prose half, kept narrow on purpose: the words a reader is given
        // BEFORE they can see whether it worked. An unconditional "becomes a
        // card" is the shape that shipped; "can become" and "still plain links"
        // are the shapes that survive a first run with the network off.
        const text = markdown();
        expect(text, "the callout should still be here").toMatch(/still plain links/);
        expect(
            /\balone on its own line becomes a card\b/.test(text),
            "the tour states unconditionally that a lone link becomes a card, and on a " +
                "first run it does not",
        ).toBe(false);
        expect(
            /\bThose cards are closed\b/.test(text),
            "the tour calls the links closed cards; with the network off no card is drawn",
        ).toBe(false);
    });

    it("the word the tour tells you to search for should be somewhere it can be found", () => {
        // The Cmd+F item names a literal word, and the only thing making that
        // gesture work is that word appearing elsewhere in the note. Nothing
        // in the text shows the coupling, so editing the section that happens
        // to contain the word teaches a new user a keystroke that finds
        // nothing. Changing the tour's Figma link is exactly that edit.
        const text = markdown();
        const item = text.split("\n").find((l) => /Cmd\+F/.test(l));
        expect(item, "the tour should still teach Cmd+F").toBeTruthy();
        const word = item!.match(/look for the word (\w+)/)?.[1];
        expect(word, `could not read the search target out of: ${item}`).toBeTruthy();
        const elsewhere = text.split("\n").filter((l) => l !== item && l.includes(word!));
        expect(elsewhere.length,
            `the tour tells you to search for "${word}" and nothing else in it says that word`)
            .toBeGreaterThan(0);
    });

    it("the tour should call the product what every other surface calls it", () => {
        // Not pinned to the heading: the tour opens on what the reader just
        // DID rather than on a masthead, so the name lands in the prose. What
        // matters is that it appears and is the shared spelling.
        expect(markdown()).toContain(JOT_PRODUCT_NAME);
    });
});
