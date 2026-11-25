/**
 * MAR-505: an edit to a line that holds a template directive must not escape
 * the directive in the saved file. Every case edits the directive's OWN line,
 * which the corpus invariants never do (invariant B checks the lines the edit
 * did not touch), and every case goes through `mergeVerified`, the function
 * that decides the bytes on either thread, because the restore leans on its
 * reparse for the cases it cannot judge from bytes.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { parserCtx, type Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { Node as ProseNode } from "../pm";
import { contentGuardPlugin } from "../plugins/contentGuard";
import { diffFingerprints, fingerprintDoc, formatFingerprintDiff } from "../plugins/fingerprints";
import { markdownProfile, computeRoundTripProtection, applyMinimalChanges } from "../utils/minimalDiff";
import { mergeVerified } from "../utils/verifiedMerge";
import { editorView, makeCorpusEditor } from "./helpers/moveFuzz";

vi.mock("../editing/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

let editors: Editor[] = [];
afterEach(async () => {
    for (const e of editors) await e.destroy();
    editors = [];
    document.body.innerHTML = "";
});

const parseWith =
    (editor: Editor) =>
    (text: string): ProseNode | null =>
        editor.action((ctx) => ctx.get(parserCtx)(text)) as ProseNode | null;

/** Position of `needle` inside the document's text, by walking text nodes. */
function findText(doc: ProseNode, needle: string): number {
    let found = -1;
    doc.descendants((node, pos) => {
        if (found >= 0) return false;
        if (node.isText) {
            const i = (node.text ?? "").indexOf(needle);
            if (i >= 0) found = pos + i;
        }
        return true;
    });
    if (found < 0) throw new Error(`text ${JSON.stringify(needle)} not in document`);
    return found;
}

/**
 * Open `saved` in the real editor, let `edit` change the live document, and
 * save the way the sync pipeline does. Returns the bytes and whether they
 * reopen as the live document.
 */
async function saveAfter(
    saved: string,
    edit: (editor: Editor) => void,
): Promise<{ text: string; canonical: boolean; serialized: string; merged: string; clean: boolean }> {
    const editor = await makeCorpusEditor(saved, [contentGuardPlugin]);
    editors.push(editor);
    const protection = computeRoundTripProtection(saved, editor.action(getMarkdown()));
    edit(editor);
    const live = editorView(editor).state.doc;
    const serialized = editor.action(getMarkdown());
    const { text, canonical } = mergeVerified(
        saved,
        serialized,
        markdownProfile,
        protection,
        live,
        parseWith(editor),
    );
    // The merge before the reparse judged it, to tell a refused restore from
    // one that never happened.
    const merged = applyMinimalChanges(saved, serialized, protection);
    const reopened = parseWith(editor)(text)!;
    const clean =
        formatFingerprintDiff(diffFingerprints(fingerprintDoc(live), fingerprintDoc(reopened))) ===
        "lost: (none); gained: (none)";
    return { text, canonical, serialized, merged, clean };
}

/** Retype `from` as `to` in the live document. */
const retype = (from: string, to: string) => (editor: Editor) => {
    const v = editorView(editor);
    const at = findText(v.state.doc, from);
    v.dispatch(v.state.tr.insertText(to, at, at + from.length));
};

const page = (line: string) => `# Page\n\n${line}\n\nAnother paragraph.\n`;

describe("template directives on an edited line (MAR-505)", () => {
    // The ticket's four reproductions: each one the serializer escapes.
    const directives = [
        "{{ page.last_modified_at }}",
        '{{</* ref "x" */>}}',
        "{% include_relative x.md %}",
        "{{ a[0] }}",
    ];
    for (const directive of directives) {
        it(`editing beside ${directive} should save the directive byte for byte`, async () => {
            const saved = page(`Edit me ${directive} here.`);
            const out = await saveAfter(saved, retype("Edit me", "Edited me"));
            // The case is real: the serializer alone escapes this directive.
            expect(out.serialized).not.toContain(directive);
            expect(out.text).toBe(page(`Edited me ${directive} here.`));
            expect(out.clean).toBe(true);
            expect(out.canonical).toBe(false);
        });
    }

    it("a directive the file spells with escapes should keep those escapes", async () => {
        const directive = "{{ a\\_b }}";
        const saved = page(`Edit me ${directive}.`);
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page(`Edited me ${directive}.`));
        expect(out.clean).toBe(true);
    });

    it("two directives with the same text should each get their own saved bytes", async () => {
        const saved = page("Edit me {{ x_y }} and {{ x\\_y }}.");
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page("Edited me {{ x_y }} and {{ x\\_y }}."));
        expect(out.clean).toBe(true);
    });

    it("a directive whose text the user changed should take the serializer's spelling", async () => {
        const saved = page("Edit me {{ page.last_modified_at }}.");
        const out = await saveAfter(saved, retype("last_modified_at", "first_modified_at"));
        expect(out.text).toBe(page("Edit me {{ page.first\\_modified\\_at }}."));
        expect(out.clean).toBe(true);
    });

    it("a restore the reparse refuses should fall back to the serializer's text", async () => {
        // `{{ *x* }}` holds an emphasis. Replacing the emphasized `x` with the
        // plain text `*x*` gives a directive whose unescaped text equals the
        // saved span's, so the saved bytes pair with it; writing them back
        // would turn the user's asterisks into emphasis again, and only the
        // reparse can see that.
        const saved = page("Edit me {{ *x* }} here.");
        const out = await saveAfter(saved, (editor) => {
            const v = editorView(editor);
            const em = v.state.schema.marks["emphasis"];
            expect(em, "schema has no emphasis mark").toBeDefined();
            const at = findText(v.state.doc, "x");
            expect(v.state.doc.rangeHasMark(at, at + 1, em)).toBe(true);
            const tr = v.state.tr.replaceWith(at, at + 1, v.state.schema.text("*x*"));
            const edit = findText(tr.doc, "Edit me");
            v.dispatch(tr.insertText("Edited me", edit, edit + "Edit me".length));
        });
        // The restore really was made, and refused by the reparse.
        expect(out.merged).toContain("Edited me {{ *x* }} here.");
        expect(out.canonical).toBe(true);
        expect(out.clean).toBe(true);
        expect(out.text).toContain("Edited me {{ \\*x\\* }} here.");
    });

    it("a directive inside an inline code span should be left to the serializer", async () => {
        const saved = page("Edit me `{{ a\\_b }}` and {{ c_d }}.");
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page("Edited me `{{ a\\_b }}` and {{ c_d }}."));
        expect(out.clean).toBe(true);
    });

    it("a code span should never take a directive's saved bytes", async () => {
        // Deleting the plain directive leaves the code span's text as its only
        // possible partner. Code content is verbatim, so pairing them would
        // drop the code's backslash.
        const saved = page("Edit me {{ a_b }} `{{ a\\_b }}`.");
        const out = await saveAfter(saved, retype("Edit me {{ a_b }}", "Edited me"));
        expect(out.merged).toBe(page("Edited me `{{ a\\_b }}`."));
        expect(out.clean).toBe(true);
    });
});
