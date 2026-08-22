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
 * What makes it checkable at all is that both links are the repository this
 * project publishes from, so the question becomes one this repo can answer:
 * are they still ours. A link to somebody else's content could only ever be
 * checked for shape, which is what a placeholder passes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recognizeEmbed } from "../embedProviders";
import { JOT_PRODUCT_NAME } from "../product";

const root = path.resolve(__dirname, "../..");
const swift = readFileSync(
    path.join(root, "jot/Sources/BirtaJotCore/FirstRunNote.swift"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

/** The tour's markdown: the one multi-line literal in that file. */
const markdown = (): string => {
    const body = swift.match(/public static let markdown = """\n([\s\S]*?)\n {4}"""/)?.[1];
    expect(body, "the tour's markdown should still be readable here").toBeTruthy();
    // Swift strips the closing delimiter's indentation from every line.
    return body!.split("\n").map((line) => line.replace(/^ {4}/, "")).join("\n");
};

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

    it("every bare link in the tour should point at the repository we publish from", () => {
        // The half a shape check cannot reach. A placeholder is well-formed by
        // construction, so "a provider claims it" is satisfied by a URL with
        // nothing behind it, which is how the tour first shipped. Tying the
        // links to the manifest makes them fail on the one event that could
        // take them offline without anybody noticing, which is a repository
        // move: the same reasoning as `releasesUrl.test.ts`, applied to a
        // document a user is handed before they have opened anything else.
        const repo: string = pkg.repository.url.replace(/\.git$/, "");
        const links = bareLinks(markdown());
        expect(links.length).toBeGreaterThanOrEqual(2);
        for (const link of links) {
            expect(link.startsWith(`${repo}/`) || link === repo,
                `${link} is not under ${repo}, so nothing here can tell whether it still resolves`)
                .toBe(true);
        }
        // And they must not all be the same URL, or "these two" is one card
        // drawn twice and the pair demonstrates nothing the single would not.
        expect(new Set(links).size, "the tour's links should be distinct").toBe(links.length);
    });

    it("the tour should draw more than one shape of card", () => {
        // The prose says a link becomes a card and shows two. Two identical
        // card kinds would still satisfy every check above while showing the
        // reader one thing twice.
        const parts = bareLinks(markdown())
            .map((l) => recognizeEmbed(l))
            .map((m) => m?.id.split("/").length);
        expect(new Set(parts).size, "the two links should not resolve to the same card shape")
            .toBeGreaterThan(1);
    });

    it("the word the tour tells you to search for should be somewhere it can be found", () => {
        // The Cmd+F item names a literal word, and the only thing making that
        // gesture work is that word appearing elsewhere in the note. Nothing
        // in the text shows the coupling, so editing the section that happens
        // to contain the word teaches a new user a keystroke that finds
        // nothing. Removing the tour's Figma link is exactly that edit.
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
