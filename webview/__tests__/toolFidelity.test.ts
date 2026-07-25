/**
 * Tool-compatibility fidelity claims (MAR-128) — the runnable proof behind
 * docs/BENEFITS.md's compatibility table. Run the whole claims set alone:
 *
 *     pnpm fidelity
 *
 * The GENERAL trust contract — a zero-edit save is byte-identical (invariant
 * A) and a real edit keeps every original line (invariant B) — is enforced
 * for every `.md` fixture, including fixtures/tools/*.md, by the shared
 * corpus harness (roundTripCorpus.test.ts). This file adds what the corpus
 * can't express:
 *
 *   - the universal floor stated as its own claim, INCLUDING the unsupported
 *     formats: the pipeline doesn't need to understand a file to hand back
 *     its exact bytes when nothing was edited;
 *   - per-construct claims: the tokens the BENEFITS table names survive an
 *     edit to a neighboring line byte-for-byte, with a one-line blast radius;
 *   - the negative claims for MDX and Org, where corruption ON EDIT is the
 *     documented, asserted outcome. If one of those tests ever fails, that is
 *     good news about the serializer — upgrade the BENEFITS row and tighten
 *     the expectation here.
 *
 * Fixture provenance and format assumptions: fixtures/tools/README.md.
 * (Logseq, the remaining 🟡 row, has its own suite: logseqRoundTrip.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
import { serializeCorpus as serialize } from "./helpers/moveFuzz";

const TOOLS_DIR = resolve(__dirname, "fixtures/tools");
const fixture = (name: string) => readFileSync(resolve(TOOLS_DIR, name), "utf8");

/**
 * Simulate the user editing one line and saving: replace `find` in the
 * serializer's own output (a faithful proxy for an in-editor text edit — see
 * logseqRoundTrip.test.ts for the reasoning) and merge the result back over
 * the saved bytes exactly as syncNow does.
 */
async function saveEditing(source: string, find: string, replace: string): Promise<string> {
    const baseline = await serialize(source);
    const protection = computeRoundTripProtection(source, baseline);
    const edited = baseline.replace(find, replace);
    expect(edited, `edit anchor ${JSON.stringify(find)} not found in serialized output`).not.toBe(baseline);
    const merged = applyMinimalChanges(source, edited, protection);
    // The edit itself must land — a merge that reverted the user's change
    // while churning another line would otherwise slip past the blast-radius
    // checks.
    expect(merged, "the edit did not survive the merge").toContain(replace);
    return merged;
}

/** Positional line diff: indices where `after` differs from `before`. */
function changedLineIndices(before: string, after: string): number[] {
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b, "line count changed — the edit's blast radius exceeded line replacement").toHaveLength(a.length);
    return a.flatMap((line, i) => (b[i] !== line ? [i] : []));
}

describe("universal floor — a zero-edit save is byte-identical even for formats Birta doesn't understand", () => {
    // For the .md fixtures this restates corpus invariant A on purpose: this
    // file alone should read as the complete claims record. For .mdx/.org it
    // is the only place the floor is asserted (they are deliberately not
    // corpus members — see fixtures/tools/README.md).
    for (const name of ["obsidian.md", "foam.md", "quarto.md", "mdx.mdx", "org.org"]) {
        it(`${name} should survive open-then-save with zero edits, byte-identically`, async () => {
            const content = fixture(name);
            const serialized = await serialize(content);
            const protection = computeRoundTripProtection(content, serialized);
            expect(applyMinimalChanges(content, serialized, protection)).toBe(content);
        });
    }
});

describe("Obsidian — preserved-text constructs survive an edit, byte-for-byte (BENEFITS: 🟢 Strong)", () => {
    it("editing a neighboring paragraph should leave every Obsidian construct untouched", async () => {
        const source = fixture("obsidian.md");
        const merged = await saveEditing(
            source,
            "Embedding pulls other files inline",
            "EDITED: embedding pulls other files inline",
        );
        // Blast radius: exactly the edited line.
        expect(changedLineIndices(source, merged)).toHaveLength(1);
        // The constructs the compatibility table names, byte-exact.
        for (const token of [
            "[[Evergreen notes]]",
            "[[Evergreen notes|evergreens]]",
            "[[Zettelkasten#Origins]]",
            "==the garden is the note, not the page==",
            "#project/attention-gardens",
            "> [!tip]- Folded by default",
            "^attention-quote",
            "[[Attention gardens#^attention-quote]]",
            "![[Evergreen notes]]",
            "![[diagrams/garden-map.png]]",
            "%%rewrite after feedback%%",
            "$e^{i\\pi} + 1 = 0$",
            "[^1]: Ahrens",
        ]) {
            expect(merged, `Obsidian construct lost or rewritten: ${token}`).toContain(token);
        }
        // And the block %%comment%% survives as a block (both fence lines).
        expect(merged).toContain("%%\nThis whole block is an Obsidian comment");
    });

    it("an edited line should keep its own inline %%comment%% unescaped", async () => {
        const merged = await saveEditing(
            fixture("obsidian.md"),
            "the draft needs work",
            "the EDITED draft needs work",
        );
        expect(merged).toContain(
            "Inline too: the EDITED draft needs work %%rewrite after feedback%% before sharing.",
        );
    });
});

describe("Foam — the autogenerated LRD shim is preserved, not inlined away (BENEFITS: 🟢 Strong)", () => {
    it("editing a list item should leave the whole link-reference block byte-exact", async () => {
        const source = fixture("foam.md");
        const merged = await saveEditing(source, "Capture reading notes", "Capture EDITED reading notes");
        expect(changedLineIndices(source, merged)).toHaveLength(1);
        // Foam regenerates this block; Birta must hand it back untouched —
        // begin marker, every definition, end marker.
        for (const line of [
            '[//begin]: # "Autogenerated link references for markdown compatibility"',
            '[project-birta]: project-birta "Project Birta"',
            '[inbox]: inbox "Inbox"',
            '[weekly-review]: weekly-review "Weekly Review"',
            '[future-note]: future-note "Future Note"',
            '[//end]: # "Autogenerated link references"',
        ]) {
            expect(merged, `LRD line lost or rewritten: ${line}`).toContain(line);
        }
        // NOTE (MAR-164, resolved): computeRoundTripProtection returns null
        // for this fixture via its "nothing to protect" early return — the
        // serializer re-emits every LRD line byte-identically and only adds
        // blank lines between them, and blank ownership is the merge's
        // territory (saved spacing wins on unedited lines), not protection's.
        // The null is benign, not a failed self-check; the test below pins
        // that protection still engages for constructs that need it in the
        // same document.
    });

    it("the LRD tail should not cost the rest of the document its round-trip protection (MAR-164)", async () => {
        // MAR-164 claimed this fixture's shape nulls protection document-wide,
        // so that a lossy construct elsewhere in the file would churn on save.
        // Pin the refutation: a setext underline shorter than its title (the
        // serializer canonicalizes it to title length, so it needs protection
        // to keep its bytes) survives an edit elsewhere exactly, LRD tail
        // present.
        const source = fixture("foam.md");
        const tailAt = source.indexOf("[//begin]");
        expect(tailAt, "foam.md lost its LRD tail").toBeGreaterThan(-1);
        const combined =
            "Intro.\n\nSection title\n--------\n\nBody text.\n\n" + source.slice(tailAt);
        // Vacuity guard: the underline must actually diverge at baseline
        // (line-exact — the canonical title-length run CONTAINS the saved
        // run as a substring). If this fails, the serializer started
        // preserving underline length and the construct no longer exercises
        // protection — swap in another lossy construct.
        expect((await serialize(combined)).split("\n")).not.toContain("--------");
        const merged = await saveEditing(combined, "Body text.", "EDITED body text.");
        expect(merged).toBe(combined.replace("Body text.", "EDITED body text."));
    });
});

describe("Quarto — pandoc extensions survive as inert text through an edit (BENEFITS: 🟡 Safe, not fluent)", () => {
    it("editing prose should leave cells, fenced divs, shortcodes, cross-refs, and citations untouched", async () => {
        const source = fixture("quarto.md");
        const merged = await saveEditing(source, "shows the relationship", "shows the EDITED relationship");
        expect(changedLineIndices(source, merged)).toHaveLength(1);
        for (const token of [
            "```{r}",
            "#| label: fig-airquality",
            '#| fig-cap: "Temperature and ozone level."',
            "::: {.callout-note}",
            "::: {#fig-elephants layout-ncol=2}",
            "![Surus](surus.png){#fig-surus}",
            "{{< video https://www.youtube.com/embed/wo9vZccmqwc >}}",
            "{{< include _setup.qmd >}}",
            "[see also @wickham2015, pp. 33-35]",
            "## Methods {#sec-methods}",
            "```{python}",
            "`{r} 6 * 7`",
        ]) {
            expect(merged, `Quarto construct lost or rewritten: ${token}`).toContain(token);
        }
    });
});

describe("MDX — risky by design: an edit corrupts the edited construct (BENEFITS: 🔴 Risky)", () => {
    it("editing the {/* comment */} line should produce escapes that are invalid MDX", async () => {
        const source = fixture("mdx.mdx");
        const merged = await saveEditing(
            source,
            "MDX comments use JS syntax",
            "EDITED: MDX comments use JS syntax",
        );
        // The corruption IS the claim: CommonMark escaping inside a JS
        // expression context is a hard MDX syntax error. This pins the exact
        // escaping observed today; a failure here means the behavior CHANGED
        // (possibly improved, possibly differently broken) — re-verify
        // against a real MDX compiler and adjust the BENEFITS row before
        // touching this test.
        expect(merged).toContain("{/\\* EDITED: MDX comments use JS syntax, not HTML. \\*/}");
        // The damage stays on the edited line; untouched MDX survives.
        for (const token of [
            "import {Chart} from './snowfall.js'",
            "export const year = 2023",
            '<Chart color="#fcb32c" year={year} />',
            "In {year}, the snowfall was above average. The expression {1 + 1} evaluates",
        ]) {
            expect(merged, `untouched MDX line lost: ${token}`).toContain(token);
        }
    });
});

describe("Org — wrong format by design: one edit rewrites org structure broadly (BENEFITS: 🔴 Wrong format)", () => {
    it("editing a headline should corrupt org syntax well beyond the edited line", async () => {
        const source = fixture("org.org");
        const merged = await saveEditing(source, "Books to read", "Books to read EDITED");
        // The parser read `* Books to read` as a bullet list, so the edit
        // re-emits it as one and the `:PROPERTIES:` drawer beneath it is
        // absorbed as that item's content, gaining two-space indentation.
        // Corruption on edit is still the documented outcome — this is WHY the
        // table says "don't" — but it is now CONFINED to the edited headline
        // and its own drawer.
        expect(merged).toContain("- Books to read EDITED");
        expect(merged).not.toContain("* Books to read");

        // Tightened 2026-07-25: the blast radius used to reach the whole file —
        // `#+TITLE:` came back as `\#+TITLE:` because a split protection
        // sub-region inherited its RUN's anchors, failed to match, and let the
        // canonical form win on a line nobody touched. Those keyword lines now
        // survive byte-for-byte, unescaped.
        expect(
            merged.split("\n").slice(0, 3),
            "untouched org keyword lines corrupted",
        ).toEqual(["#+TITLE: Reading queue", "#+AUTHOR: Harlan", "#+STARTUP: overview"]);
        expect(merged).not.toContain("\\#+");

        // Everything below the edited headline's own drawer is untouched.
        for (const token of [
            "** TODO How to Take Smart Notes",
            "SCHEDULED: <2026-08-01 Sat>",
            "CLOCK: [2026-07-10 Fri 09:00]--[2026-07-10 Fri 09:45] =>  0:45",
            "#+BEGIN_SRC emacs-lisp",
            "(setq org-log-done 'time)",
            "Org links look like [[https://orgmode.org][the org manual]], not Markdown.",
        ]) {
            expect(merged, `line beyond the edit's section changed: ${token}`).toContain(token);
        }

        // Pinned exactly: the headline plus the three drawer lines it swallowed.
        const changed = changedLineIndices(source, merged);
        expect(changed, "org blast radius moved — re-verify and re-tighten").toEqual([4, 5, 6, 7]);
    });
});
