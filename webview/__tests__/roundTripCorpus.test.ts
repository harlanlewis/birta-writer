/**
 * Round-trip fidelity corpus: every fixture in __tests__/fixtures/ is driven
 * through the REAL Milkdown editor (real parser, real remark-stringify, the
 * production serialization config) plus the real minimal-diff merge with
 * round-trip protection — no mocks.
 *
 * Invariants (the trust contract of the editor):
 *   A. Opening a file and saving without edits reproduces it BYTE-IDENTICALLY.
 *   B. A real edit changes only the edited region: every original significant
 *      line survives verbatim (reference definitions, setext headings, HTML
 *      comments, escaping — nothing is silently dropped or rewritten).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, pureCommonmark } from "../serialization";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";

const FIXTURES_DIR = join(__dirname, "fixtures");
const fixtures = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ name: f, content: readFileSync(join(FIXTURES_DIR, f), "utf8") }));

// The living showcase (samples/content-inventory.md) doubles as a corpus
// member: every content type it demonstrates must round-trip byte-identically,
// so an inventory edit that breaks a fidelity claim fails here. The extension
// strips YAML frontmatter before the webview ever sees content
// (src/utils/contentTransform.ts), so the corpus tests the body exactly as
// production delivers it.
{
    const raw = readFileSync(join(__dirname, "..", "..", "samples", "content-inventory.md"), "utf8");
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
    fixtures.push({ name: "samples/content-inventory.md (body)", content: body });
}

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
}

/** Significant (non-blank) lines of a document. */
function sig(text: string): string[] {
    return text.split("\n").filter((l) => l.trim() !== "");
}

describe("corpus invariant A — open then save without edits is byte-identical", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should round-trip unchanged`, async () => {
            const editor = await makeEditor(content);
            const serialized = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized);

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toBe(content);
            await editor.destroy();
        });
    }
});

describe("corpus invariant B — an edit keeps every original line intact", () => {
    for (const { name, content } of fixtures) {
        it(`${name} should lose nothing when a paragraph is added`, async () => {
            const editor = await makeEditor(content);
            const serialized0 = editor.action(getMarkdown());
            const protection = computeRoundTripProtection(content, serialized0);

            // The edit: a brand-new paragraph inserted at the very top.
            editor.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const para = view.state.schema.nodes["paragraph"].create(
                    null,
                    view.state.schema.text("Corpus edit marker paragraph."),
                );
                view.dispatch(view.state.tr.insert(0, para));
            });
            const serialized = editor.action(getMarkdown());

            const merged = applyMinimalChanges(content, serialized, protection);

            expect(merged).toContain("Corpus edit marker paragraph.");
            // Every original significant line must survive byte-for-byte AND
            // in the original order (an adversarial review found a merge that
            // preserved the line multiset while reordering the document).
            const mergedSig = sig(merged);
            let at = 0;
            for (const line of sig(content)) {
                let found = -1;
                for (let i = at; i < mergedSig.length; i++) {
                    if (mergedSig[i] === line) { found = i; break; }
                }
                expect(found, `original line lost or out of order: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
                at = found + 1;
            }
            // The inserted paragraph must sit at the very top, above all
            // original content.
            expect(mergedSig[0]).toBe("Corpus edit marker paragraph.");
            await editor.destroy();
        });
    }
});
