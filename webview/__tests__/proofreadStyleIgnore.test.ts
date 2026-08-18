import { describe, it, expect } from "vitest";
import { Schema } from "../pm";
import { computeDecorations, DEFAULT_CONFIG } from "../plugins/proofread";
import { ignoreStyleSession, isStyleSuppressed, keepStylePhrase } from "../proofread/engine";
import { isPhraseCategory } from "../utils/styleMatcher";
import { mockVscodeApi } from "./setup";
import type { ProofreadConfig } from "../../shared/messages";

/**
 * Style-check session ignore: clicking "Ignore" on a style finding suppresses
 * that category+text for the session (mirroring the Harper lint ignore).
 * Vitest isolates module state per file, so the engine's `styleIgnores` set
 * starts empty here and mutations don't leak into the other proofread specs.
 */

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

const CONFIG: ProofreadConfig = {
    ...DEFAULT_CONFIG,
    spellCheck: false,
    grammarCheck: false,
};

function decoratedTexts(text: string): string[] {
    const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text(text)]),
    ]);
    return computeDecorations(doc, CONFIG).find().map((d) => doc.textBetween(d.from, d.to));
}

describe("ignoreStyleSession / isStyleSuppressed", () => {
    it("a category+text should read as suppressed only after it is ignored", () => {
        expect(isStyleSuppressed("fillers", "really")).toBe(false);
        ignoreStyleSession("fillers", "really");
        expect(isStyleSuppressed("fillers", "really")).toBe(true);
    });

    it("the ignore should be case-insensitive on the flagged text", () => {
        ignoreStyleSession("fillers", "Basically");
        expect(isStyleSuppressed("fillers", "basically")).toBe(true);
    });

    it("a different category with the same text should not be suppressed", () => {
        ignoreStyleSession("fillers", "clean");
        expect(isStyleSuppressed("redundancies", "clean")).toBe(false);
    });
});

describe("computeDecorations honours a style ignore", () => {
    it("an ignored filler should drop out of the decorations", () => {
        expect(decoratedTexts("This is actually good.")).toEqual(["actually"]);
        ignoreStyleSession("fillers", "actually");
        expect(decoratedTexts("This is actually good.")).toEqual([]);
    });
});

/**
 * "Keep this phrase" (MAR-236): the protect-list gesture. It suppresses like a
 * session ignore at once AND asks the extension to persist the phrase to
 * birta.styleCheck.exceptions, so it stays kept across sessions.
 */
describe("keepStylePhrase", () => {
    it("a kept phrase should be suppressed at once and posted for persistence", () => {
        expect(isStyleSuppressed("cliches", "at the end of the day")).toBe(false);

        keepStylePhrase("cliches", "at the end of the day");

        expect(isStyleSuppressed("cliches", "at the end of the day")).toBe(true);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "styleAddException",
            phrase: "at the end of the day",
        });
    });

    it("a kept phrase should drop out of the decorations like an ignore", () => {
        expect(decoratedTexts("It is very good.")).toEqual(["very"]);
        keepStylePhrase("fillers", "very");
        expect(decoratedTexts("It is very good.")).toEqual([]);
    });
});

describe("isPhraseCategory (which findings offer Keep this phrase)", () => {
    it("the six phrase-list categories should qualify and the structural ones should not", () => {
        for (const c of ["fillers", "redundancies", "cliches", "wordiness", "aiVocabulary", "aiArtifacts"]) {
            expect(isPhraseCategory(c), c).toBe(true);
        }
        for (const c of ["passive", "longSentences", "emDash", "nonAsciiPunct", "rhythm", "repeated", "absolutePerf"]) {
            expect(isPhraseCategory(c), c).toBe(false);
        }
    });
});
