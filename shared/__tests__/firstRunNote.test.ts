/**
 * The first-run tour's embed links, checked against the recognizers that have
 * to claim them.
 *
 * The tour promises that "a link alone on its own line becomes a card" and
 * then prints two links as the demonstration. If a recognizer stops matching
 * one, nothing fails: the link renders as a link, the sentence above it
 * becomes false, and the first thing a new user does is watch the product not
 * do what its own welcome note said it would. Nothing else asks this question,
 * because the tour is a Swift string and the recognizers are TypeScript.
 *
 * The URLs are placeholders with no content behind them, which this does not
 * check and could not: whether a card RESOLVES is a network fact, and the
 * network ships off. What is checked is the only half that is ours, which is
 * whether the card is drawn at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { recognizeEmbed, type EmbedKind } from "../embedProviders";
import { JOT_PRODUCT_NAME } from "../product";

const root = path.resolve(__dirname, "../..");
const swift = readFileSync(
    path.join(root, "jot/Sources/BirtaJotCore/FirstRunNote.swift"), "utf8");

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

    it("the tour should demonstrate the two providers it names in its prose", () => {
        const text = markdown();
        const kinds = new Set(bareLinks(text).map((l) => recognizeEmbed(l)?.kind));
        // Named in the sentence above the links, so the sentence and the
        // demonstration cannot drift apart without this failing.
        for (const [kind, prose] of [["loom", "Loom"], ["figma", "Figma"]] as const) {
            expect(kinds, `the tour should carry a ${kind} link`).toContain(kind as EmbedKind);
            expect(text, `the tour's prose should still name ${prose}`).toContain(prose);
        }
    });

    it("the tour should call the product what every other surface calls it", () => {
        expect(markdown()).toContain(`# Welcome to ${JOT_PRODUCT_NAME}`);
    });
});
