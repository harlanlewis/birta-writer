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
import { getMarkdown } from "@milkdown/utils";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
import { makeCorpusEditor } from "./helpers/moveFuzz";

/**
 * Parse `markdown` into the real editor and serialize it straight back. Uses the
 * shared corpus editor factory so this suite can't drift from the production
 * serialization recipe the corpus (roundTripCorpus.test.ts) exercises.
 */
async function serialize(markdown: string): Promise<string> {
    const editor = await makeCorpusEditor(markdown);
    const out = editor.action(getMarkdown());
    await editor.destroy();
    return out;
}

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

describe("Logseq round-trip — KNOWN GAPS: editing a fragile block churns its local region", () => {
    it("editing a tab-indented block should collapse tabs to spaces across its sibling subtree", async () => {
        const merged = await saveEditing("A nested child block", "An EDITED nested child block");
        // want: the edited subtree keeps its tabs ("\t- ...").
        expect(merged).toContain("  - An EDITED nested child block");
        expect(merged).not.toContain("\t- An EDITED nested child block");
        // Blast radius is LOCAL: an unrelated tab-indented subtree still has tabs.
        expect(merged).toContain("\t- > A blockquote nested inside a bullet.");
    });

    it("editing an org-cookie line should backslash-escape the cookie", async () => {
        const merged = await saveEditing(
            "Draft synthetic Logseq fixtures",
            "EDITED synthetic Logseq fixtures",
        );
        // want: "[#A]" survives verbatim on an edited line.
        expect(merged).toContain("- DOING EDITED synthetic Logseq fixtures \\[#A]");
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
