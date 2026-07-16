/**
 * Logseq-specific round-trip gaps (phase-0-fidelity).
 *
 * The GENERAL trust contract — untouched files are byte-identical (invariant A)
 * and a real edit preserves every original line (invariant B) — is enforced for
 * the Logseq fixtures by the shared corpus harness (roundTripCorpus.test.ts),
 * which auto-discovers fixtures/logseq/*.md. Do not duplicate A/B here.
 *
 * This file pins the Logseq-SPECIFIC churn that the corpus can't express,
 * because these assertions document *non*-identity: what still goes wrong when
 * the user edits a fragile block. The blast radius is local (only the edited
 * block's region), but within it:
 *   - a tab-indented block's subtree collapses tabs to spaces, and
 *   - an edited org-cookie line picks up a `\` escape (`[#A]` -> `\[#A]`).
 * Tighten these toward byte-identity as MAR-131 lands; don't delete them.
 *
 * See fixtures/logseq/README.md for the (synthetic) fixture format assumptions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
// The shared factory-backed serializer keeps this suite on the exact
// production serialization recipe the corpus (roundTripCorpus.test.ts)
// exercises.
import { serializeCorpus as serialize } from "./helpers/moveFuzz";

const PAGE = readFileSync(resolve(__dirname, "fixtures/logseq/page.md"), "utf8");

// One editor spin-up for the page fixture, shared across the gap cases below.
let cached: Promise<{ baseline: string; protection: ReturnType<typeof computeRoundTripProtection> }> | null = null;
function loadPage() {
    if (!cached) {
        cached = serialize(PAGE).then((baseline) => ({
            baseline,
            protection: computeRoundTripProtection(PAGE, baseline),
        }));
    }
    return cached;
}

/**
 * Simulate the user editing one block and saving. `find`/`replace` operate on
 * the serializer's own output (`baseline`) — a faithful proxy for
 * `serialize(editedDoc)` for a TEXT-level edit, because the serializer is
 * deterministic and local, so changing one block's text there matches what an
 * in-editor edit emits. (Structural edits are covered generically by corpus
 * invariant B, which drives a real ProseMirror transaction.) Anchor on a
 * substring stable across saved and baseline so escaping never breaks the match.
 */
async function saveEditing(find: string, replace: string): Promise<string> {
    const { baseline, protection } = await loadPage();
    const edited = baseline.replace(find, replace);
    expect(edited, `edit anchor "${find}" not found in serialized output`).not.toBe(baseline);
    return applyMinimalChanges(PAGE, edited, protection);
}

describe("Logseq round-trip — editing one block leaves every other line byte-intact (MAR-131)", () => {
    it("editing a tab-indented block keeps every untouched sibling's tabs", async () => {
        const merged = await saveEditing("A nested child block", "An EDITED nested child block");
        // The edited line itself re-emits with the serializer's space
        // indentation — its own byte style is the cosmetic remainder
        // (MAR-132's Logseq flag, someday). Depth is preserved either way.
        expect(merged).toContain("- An EDITED nested child block");
        // Every UNTOUCHED line keeps its tab bytes — the edit's blast radius
        // is exactly the edited line, not its contiguous churn region
        // (normLineForCompare treats a leading tab as two spaces, so
        // tab-indented lines are keeps and no region forms around them).
        expect(merged).toContain("\t- A child that carries block properties.");
        expect(merged).toContain("\t\t- A grandchild, two tabs deep.");
        expect(merged).toContain("\t- > A blockquote nested inside a bullet.");
    });

    it("editing an org-cookie line keeps the cookie unescaped", async () => {
        const merged = await saveEditing(
            "Draft synthetic Logseq fixtures",
            "EDITED synthetic Logseq fixtures",
        );
        // `\[#A]` is not a priority cookie in Logseq — it's literal text.
        // The serializer no longer escapes cookie/timestamp-shaped brackets
        // (serialization.ts text handler), so even the edited line's own
        // bytes keep the cookie meaningful.
        expect(merged).toContain("- DOING EDITED synthetic Logseq fixtures [#A]");
        expect(merged).not.toContain("\\[#A]");
        expect(merged).not.toContain("CLOCK: \\[");
    });

    it("editing one block in a LONG contiguous nested run changes exactly that line", async () => {
        // The original fixture interleaves top-level bullets, which chop the
        // churn into small regions and once made the blast radius look
        // "local" by accident (the MAR-131 fixture artifact). This is the
        // honest shape: one long tab-indented run — an edit anywhere inside
        // it must not rewrite the rest.
        const longRun =
            "- Root block\n" +
            Array.from({ length: 25 }, (_, i) =>
                `\t- Child number ${i} holds a cookie [#B]\n\t  CLOCK: [2026-07-1${i % 10} Sun 10:00:00]`,
            ).join("\n") +
            "\n";
        const baseline = await serialize(longRun);
        const protection = computeRoundTripProtection(longRun, baseline);
        const edited = baseline.replace("Child number 12 holds", "Child number 12 EDITED holds");
        expect(edited).not.toBe(baseline);
        const merged = applyMinimalChanges(longRun, edited, protection);

        const before = longRun.split("\n");
        const after = merged.split("\n");
        // POSITIONAL diff, not set difference: the fixture's CLOCK lines
        // repeat (i % 10), so a membership check could hide a dropped
        // duplicate. Same line count, exactly one differing position.
        expect(after).toHaveLength(before.length);
        const changedIdx = before.flatMap((l, i) => (after[i] !== l ? [i] : []));
        expect(changedIdx).toHaveLength(1);
        expect(after[changedIdx[0]!]).toContain("Child number 12 EDITED holds a cookie [#B]");
        // And the untouched neighbors kept tabs AND cookies byte-exactly.
        expect(merged).toContain("\t- Child number 11 holds a cookie [#B]");
        expect(merged).toContain("\t- Child number 13 holds a cookie [#B]");
        expect(merged).toContain("\t  CLOCK: [2026-07-13 Sun 10:00:00]");
    });

    it("a cookie-shaped bracket with a matching reference DEFINITION keeps its escape", async () => {
        // Adversarial-probe find: `[3/7]` with a `[3/7]: url` definition in
        // the document is a live shortcut reference — unescaping a saved
        // `\[3/7]` literal would manufacture a link out of plain text. The
        // serializer's unescape pass (unescapeOrgCookies) is definition-
        // aware, so this document's escape survives an edit to its line.
        const source = "Progress \\[3/7] done today.\n\n[3/7]: https://example.com\n";
        const baseline = await serialize(source);
        expect(baseline).toContain("\\[3/7]");
        const protection = computeRoundTripProtection(source, baseline);
        const edited = baseline.replace("done today", "done EDITED today");
        expect(edited).not.toBe(baseline);
        const merged = applyMinimalChanges(source, edited, protection);
        expect(merged).toContain("Progress \\[3/7] done EDITED today.");
    });

    it("a cookie inside a fenced code block keeps its bytes verbatim", async () => {
        // Fence content is user bytes; the unescape pass must never touch
        // it. A literal `\[#A]` typed inside a code fence survives an edit
        // elsewhere in the document.
        const source = "- A block with code:\n\n  ```\n  literal \\[#A] stays escaped\n  ```\n\nTail [#A] prose.\n";
        const baseline = await serialize(source);
        const protection = computeRoundTripProtection(source, baseline);
        const edited = baseline.replace("Tail", "Tail EDITED");
        expect(edited).not.toBe(baseline);
        const merged = applyMinimalChanges(source, edited, protection);
        expect(merged).toContain("literal \\[#A] stays escaped");
        // …while the prose cookie outside the fence is unescaped as intended.
        expect(merged).toContain("Tail EDITED [#A] prose.");
    });
});

describe("Logseq round-trip — serializer preserves Logseq tokens as literal text", () => {
    it("properties, refs, macros, tags, and wikilinks should survive re-serialization unmangled", async () => {
        // Why this matters: because these survive a full re-serialize, an edit to
        // a block that CONTAINS one of them does not corrupt the token.
        const { baseline } = await loadPage();
        for (const token of [
            "collapsed:: true",
            "((66a1b2c3-d4e5-6789-abcd-ef0123456789))",
            "{{query (and [[project]] (task TODO DOING))}}",
            "{{embed [[Another Page]]}}",
            "#[[multi word tag]]",
            "SCHEDULED: <2026-07-15 Wed>",
        ]) {
            expect(baseline).toContain(token);
        }
    });
});
