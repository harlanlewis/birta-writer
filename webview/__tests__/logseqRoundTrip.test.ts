/**
 * Logseq round-trip characterization (phase-0-fidelity).
 *
 * Logseq stores file-based graphs as `.md` whose whole document is an outliner:
 * every block is a `- ` bullet, tab indentation encodes the block tree, and
 * page/block properties (`key:: value`), refs (`[[Page]]`, `((uuid))`), macros
 * (`{{query}}`, `{{embed}}`), `#tags`, and org-style task markers
 * (`TODO`/`DOING`/`[#A]`/`SCHEDULED:`/`:LOGBOOK:`) live inside those bullets.
 *
 * These tests drive the REAL production serializer (the wikiLinks.test.ts
 * harness) against synthetic Logseq fixtures to pin down exactly where fidelity
 * holds and where it breaks. They split into two contracts:
 *
 *   1. GUARANTEE — opening and saving an *untouched* Logseq file is
 *      byte-identical. The minimalDiff protection layer (computeRoundTrip
 *      protection + applyMinimalChanges) rescues the serializer's churn for any
 *      line the user did not touch. This must never regress.
 *
 *   2. KNOWN GAPS (baseline) — the *pure serializer* churn that lands the moment
 *      the user edits a Logseq block (edited regions bypass protection). Each
 *      assertion documents one corruption risk tracked in Linear. As fidelity
 *      work lands, these assertions should be TIGHTENED toward byte-identity
 *      (flip the expectation and update the fixture), never deleted to go green.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";

/** Parse `markdown` into the real editor and serialize it straight back. */
async function serialize(markdown: string): Promise<string> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

function fixture(name: string): string {
    return readFileSync(resolve(__dirname, `fixtures/logseq/${name}.md`), "utf8");
}

/**
 * The save path for an UNTOUCHED document: baseline-serialize on load, build
 * round-trip protection, then merge with no user edits. Mirrors what the
 * webview does on a save where nothing changed.
 */
async function saveUntouched(saved: string): Promise<string> {
    const baseline = await serialize(saved);
    const protection = computeRoundTripProtection(saved, baseline);
    return applyMinimalChanges(saved, baseline, protection);
}

describe("Logseq round-trip — GUARANTEE: untouched file is byte-identical", () => {
    for (const name of ["page", "journal"]) {
        it(`${name}.md opened and saved unchanged should equal the source bytes`, async () => {
            const saved = fixture(name);
            expect(await saveUntouched(saved)).toBe(saved);
        });
    }
});

/**
 * KNOWN GAPS — pure-serializer churn that corrupts edited Logseq blocks today.
 * Each `expect` encodes a tracked fidelity gap; tightening it toward the
 * commented "want" is the acceptance signal for the fix.
 */
describe("Logseq round-trip — KNOWN GAPS: pure serializer churn on edit", () => {
    it("rewrites Logseq tab indentation as two spaces", async () => {
        const out = await serialize(fixture("page"));
        // want: nested blocks keep their leading tabs ("\t- …").
        expect(out).not.toContain("\t- ");
        expect(out).toContain("  - A nested child block");
    });

    it("splits a heading-as-block ('- # H') into an empty bullet plus heading", async () => {
        const out = await serialize(fixture("page"));
        // want: "- # Project Atlas" survives as a single line.
        expect(out).not.toContain("- # Project Atlas");
        expect(out).toMatch(/-\n {2}# Project Atlas/);
    });

    it("backslash-escapes org priority and timestamp cookies", async () => {
        const out = await serialize(fixture("page"));
        // want: "[#A]" and "[2026-07-12 …]" survive verbatim.
        expect(out).toContain("\\[#A]");
        expect(out).toContain("\\[2026-07-12 Sun 10:00:00]");
    });

    it("preserves properties, refs, macros, tags, and wikilinks as literal text", async () => {
        // These constructs are NOT corrupted — they round-trip as plain text
        // (only [[Page]] renders specially, via the existing wikilink atom).
        const out = await serialize(fixture("page"));
        for (const token of [
            "collapsed:: true",
            "((66a1b2c3-d4e5-6789-abcd-ef0123456789))",
            "{{query (and [[project]] (task TODO DOING))}}",
            "{{embed [[Another Page]]}}",
            "#[[multi word tag]]",
            "SCHEDULED: <2026-07-15 Wed>",
        ]) {
            expect(out).toContain(token);
        }
    });
});
