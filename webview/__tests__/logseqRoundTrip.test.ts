/**
 * Logseq round-trip characterization (phase-0-fidelity).
 *
 * Logseq stores file-based graphs as `.md` whose whole document is an outliner:
 * every block is a `- ` bullet, tab indentation encodes the block tree, and
 * page/block properties (`key:: value`), refs (`[[Page]]`, `((uuid))`), macros
 * (`{{query}}`, `{{embed}}`), `#tags`, and org-style task markers
 * (`TODO`/`DOING`/`[#A]`/`SCHEDULED:`/`:LOGBOOK:`) live inside those bullets.
 * See fixtures/logseq/README.md for the format assumptions these files encode.
 *
 * These tests drive the REAL production serializer AND the real save-path merge
 * (the wikiLinks.test.ts harness + minimalDiff), because what reaches disk is
 * never the raw serializer output — it is `applyMinimalChanges(saved,
 * serialized, protection)`, which re-emits only the regions the user actually
 * changed. So the meaningful question is not "does a full re-serialize churn?"
 * (it does) but "when the user edits one block, what happens to the rest?".
 *
 * Contracts, in order of what a user feels:
 *   1. GUARANTEE — opening/saving an untouched file is byte-identical.
 *   2. GUARANTEE — editing a top-level block changes ONLY that block; the rest
 *      of the file (tabs, org cookies, heading-as-block) survives verbatim.
 *   3. KNOWN GAPS — editing a *fragile* block churns its own local region:
 *      tab indentation collapses to spaces across the edited block's sibling
 *      subtree, and an edited `[#A]`/timestamp line picks up a `\` escape. The
 *      blast radius is local, not the whole file. Tighten these toward
 *      byte-identity as fidelity work lands (MAR-131), don't delete them.
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

interface Loaded {
    saved: string;
    baseline: string;
    protection: ReturnType<typeof computeRoundTripProtection>;
}

// One editor spin-up per fixture, shared across every test that needs it.
const cache = new Map<string, Promise<Loaded>>();
function load(name: string): Promise<Loaded> {
    let hit = cache.get(name);
    if (!hit) {
        hit = (async () => {
            const saved = readFileSync(resolve(__dirname, `fixtures/logseq/${name}.md`), "utf8");
            const baseline = await serialize(saved);
            return { saved, baseline, protection: computeRoundTripProtection(saved, baseline) };
        })();
        cache.set(name, hit);
    }
    return hit;
}

/**
 * Simulate the user editing one block and saving. `find`/`replace` operate on
 * the serializer's own output (`baseline`) — a faithful proxy for
 * `serialize(editedDoc)` because the serializer is deterministic and local, so
 * changing one block's text there matches what an in-editor edit would emit.
 * Use a substring stable across saved and baseline so escaping never breaks the
 * match. Returns exactly what the merge writes to disk.
 */
async function saveEditing(name: string, find: string, replace: string): Promise<string> {
    const { saved, baseline, protection } = await load(name);
    const edited = baseline.replace(find, replace);
    expect(edited, `edit anchor "${find}" not found in serialized output`).not.toBe(baseline);
    return applyMinimalChanges(saved, edited, protection);
}

describe("Logseq round-trip — GUARANTEE: untouched file is byte-identical", () => {
    for (const name of ["page", "journal"]) {
        it(`${name}.md opened and saved unchanged should equal the source bytes`, async () => {
            const { saved, baseline, protection } = await load(name);
            expect(applyMinimalChanges(saved, baseline, protection)).toBe(saved);
        });
    }
});

describe("Logseq round-trip — GUARANTEE: editing a top-level block spares the rest", () => {
    it("changes only the edited line; tabs, cookies, and heading-as-block survive", async () => {
        const { saved } = await load("page");
        const before = "A normal block with a [[Page Reference]]";
        const after = "An EDITED block with a [[Page Reference]]";
        const merged = await saveEditing("page", before, after);

        // The whole file is byte-identical except the one edited line.
        expect(merged).toBe(saved.replace(before, after));

        // Spot-check the fragile constructs elsewhere are untouched.
        expect(merged).toContain("\t- A nested child block, one tab deeper.");
        expect(merged).toContain("- DOING Draft synthetic Logseq fixtures [#A]");
        expect(merged).toContain("  CLOCK: [2026-07-12 Sun 10:00:00]");
        expect(merged).toContain("- # Project Atlas");
    });
});

describe("Logseq round-trip — KNOWN GAPS: editing a fragile block churns its local region", () => {
    it("editing a tab-indented block collapses tabs to spaces across its sibling subtree", async () => {
        const merged = await saveEditing("page", "A nested child block", "An EDITED nested child block");
        // want: the edited subtree keeps its tabs ("\t- …").
        expect(merged).toContain("  - An EDITED nested child block");
        expect(merged).not.toContain("\t- An EDITED nested child block");
        // Blast radius is LOCAL: an unrelated tab-indented subtree still has tabs.
        expect(merged).toContain("\t- > A blockquote nested inside a bullet.");
    });

    it("editing an org-cookie line backslash-escapes the cookie", async () => {
        const merged = await saveEditing(
            "page",
            "Draft synthetic Logseq fixtures",
            "EDITED synthetic Logseq fixtures",
        );
        // want: "[#A]" survives verbatim on an edited line.
        expect(merged).toContain("- DOING EDITED synthetic Logseq fixtures \\[#A]");
    });
});

describe("Logseq round-trip — serializer preserves Logseq tokens as literal text", () => {
    it("properties, refs, macros, tags, and wikilinks are not mangled on re-serialize", async () => {
        // Why this matters: because these survive a full re-serialize, an edit to
        // a block that CONTAINS one of them does not corrupt the token.
        const { baseline } = await load("page");
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
