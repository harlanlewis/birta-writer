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
        // NOTE (MAR-164): this fixture's LRD shape makes
        // computeRoundTripProtection fail its self-check and return null, so
        // the guarantee asserted here rides on the minimal-diff merge alone.
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
        // The parser read `* Books to read` as a list; the edit re-emits it
        // as one, and the churn region around the edit drags neighbors with
        // it — keyword lines gain escapes, the drawer gains indentation.
        // This asserted corruption is WHY the table says "don't". A failure
        // here means the behavior CHANGED (not necessarily improved) —
        // re-verify what an edit actually does to an .org file before
        // changing the row or this test.
        expect(merged).toContain("- Books to read EDITED");
        expect(merged).not.toContain("* Books to read");
        expect(merged).toContain("\\#+TITLE: Reading queue");
        const before = source.split("\n");
        const after = merged.split("\n");
        const changed = before.filter((line, i) => after[i] !== line);
        expect(changed.length, "expected the edit's blast radius to exceed one line").toBeGreaterThan(1);
    });
});
