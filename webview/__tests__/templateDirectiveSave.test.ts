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
import { serializeVerbatim } from "../serialization";
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
): Promise<{
    text: string;
    canonical: boolean;
    serialized: string;
    strict: string;
    verbatim: boolean;
    merged: string;
    clean: boolean;
}> {
    const editor = await makeCorpusEditor(saved, [contentGuardPlugin]);
    editors.push(editor);
    // Composed exactly as `mergeForSave` and `getProtection` (editor.ts) and
    // the sync worker do: the save path serializes verbatim, everything else strict.
    const protection = computeRoundTripProtection(saved, serializeVerbatim(() => editor.action(getMarkdown())).text);
    edit(editor);
    const live = editorView(editor).state.doc;
    const { text: serialized, verbatim } = serializeVerbatim(() => editor.action(getMarkdown()));
    const strict = editor.action(getMarkdown());
    const { text, canonical } = mergeVerified(
        saved,
        serialized,
        markdownProfile,
        protection,
        live,
        parseWith(editor),
        verbatim ? () => strict : undefined,
    );
    // The merge before the reparse judged it, to tell a refused restore from
    // one that never happened.
    const merged = applyMinimalChanges(saved, serialized, protection);
    const reopened = parseWith(editor)(text)!;
    const clean =
        formatFingerprintDiff(diffFingerprints(fingerprintDoc(live), fingerprintDoc(reopened))) ===
        "lost: (none); gained: (none)";
    return { text, canonical, serialized, strict, verbatim, merged, clean };
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
            // The case is real: the strict spelling escapes this directive.
            expect(out.strict).not.toContain(directive);
            expect(out.text).toBe(page(`Edited me ${directive} here.`));
            expect(out.clean).toBe(true);
        });
    }

    it("a directive the file spells with escapes should keep those escapes", async () => {
        const directive = "{{ a\\_b }}";
        const saved = page(`Edit me ${directive}.`);
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page(`Edited me ${directive}.`));
        expect(out.clean).toBe(true);
    });

    it("a directive escape the serializer drops should be kept", async () => {
        // `\.` is an escape the serializer has no need to write, so the
        // serializer's span carries no backslash and differs only by losing it.
        const directive = "{{ a\\.b }}";
        const saved = page(`Edit me ${directive} here.`);
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.serialized).toContain("{{ a.b }}");
        expect(out.text).toBe(page(`Edited me ${directive} here.`));
        expect(out.clean).toBe(true);
    });

    it("two directives with the same text should each get their own saved bytes", async () => {
        const saved = page("Edit me {{ x_y }} and {{ x\\_y }}.");
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page("Edited me {{ x_y }} and {{ x\\_y }}."));
        expect(out.clean).toBe(true);
    });

    it("a restore the reparse refuses should fall back to the strict spelling", async () => {
        // `{{ *x* }}` holds an emphasis. Replacing the emphasized `x` with the
        // plain text `*x*` gives a directive the serializer writes verbatim as
        // `{{ *x* }}`, and the saved span pairs with it too; either way the
        // user's asterisks would reopen as emphasis, and only the reparse can
        // see that.
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
        // The verbatim bytes really were the candidate, and refused by the reparse.
        expect(out.verbatim).toBe(true);
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

describe("template directives the serializer writes itself (MAR-507)", () => {
    it("a directive whose text the user changed should be saved as it reads", async () => {
        const saved = page("Edit me {{ page.last_modified_at }}.");
        const out = await saveAfter(saved, retype("last_modified_at", "first_modified_at"));
        expect(out.verbatim).toBe(true);
        expect(out.strict).toContain("first\\_modified\\_at");
        expect(out.text).toBe(page("Edit me {{ page.first_modified_at }}."));
        expect(out.clean).toBe(true);
    });

    it("joining a directive's paragraph into the one above should keep the directive", async () => {
        const saved = "# Page\n\nPara one.\n\n{{ page.last_modified_at }} here.\n\nTail.\n";
        const out = await saveAfter(saved, (editor) => {
            const v = editorView(editor);
            v.dispatch(v.state.tr.join(v.state.doc.resolve(0).posAtIndex(2)));
        });
        expect(out.text).toBe("# Page\n\nPara one.{{ page.last_modified_at }} here.\n\nTail.\n");
        expect(out.clean).toBe(true);
    });

    it("splitting a directive's line should keep the directive", async () => {
        const saved = page("Before {{ page.last_modified_at }} after.");
        const out = await saveAfter(saved, (editor) => {
            const v = editorView(editor);
            // Enter where the space was: the space goes, the line breaks there.
            const at = findText(v.state.doc, " after.");
            v.dispatch(v.state.tr.delete(at, at + 1).split(at));
        });
        expect(out.text).toBe("# Page\n\nBefore {{ page.last_modified_at }}\n\nafter.\n\nAnother paragraph.\n");
        expect(out.clean).toBe(true);
    });

    it("a directive typed into a new paragraph should be saved as it reads", async () => {
        const saved = page("Edit me.");
        const out = await saveAfter(saved, (editor) => {
            const v = editorView(editor);
            const end = findText(v.state.doc, "Edit me.") + "Edit me.".length;
            const tr = v.state.tr.split(end);
            v.dispatch(tr.insertText("{% include_relative notes/a_b.md %}", tr.mapping.map(end) + 1));
        });
        expect(out.text).toContain("\n\n{% include_relative notes/a_b.md %}\n\n");
        expect(out.clean).toBe(true);
    });

    it("a directive that would reopen as a link should be saved escaped", async () => {
        // `[0]` written verbatim meets the document's own `[0]:` definition and
        // reopens as a link, which no reading of the directive alone can see.
        const saved = "# Page\n\nEdit me {{ a\\[0] }} here.\n\n[0]: https://example.com\n";
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.verbatim).toBe(true);
        expect(out.serialized).toContain("{{ a[0] }}");
        expect(out.text).toContain("Edited me {{ a\\[0] }} here.");
        expect(out.clean).toBe(true);
    });

    it("an edited directive that would reopen as a link should be saved escaped", async () => {
        // The edited directive has no saved partner, so the merge is the
        // serializer's own text, which a verbatim serialize must not let
        // through unparsed.
        const saved = "# Page\n\nSee {{ a\\[0] }} here.\n\n[0]: https://example.com\n";
        const out = await saveAfter(saved, retype("a[0]", "b[0]"));
        expect(out.verbatim).toBe(true);
        expect(out.merged).toContain("See {{ b[0] }} here.");
        expect(out.text).toContain("See {{ b\\[0] }} here.");
        expect(out.clean).toBe(true);
    });

    it("a directive holding a URL should keep its bytes when the line is edited around it", async () => {
        // GFM reads the bare URL as a link, so the directive's text arrives
        // split across a link mark and reaches neither the verbatim write nor
        // the restore whole. Editing beside it must still not touch it.
        const saved = page('Edit me {{ "https://example.com/a_b" | x }} here.');
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page('Edited me {{ "https://example.com/a_b" | x }} here.'));
    });

    it("a URL edited inside a directive should be saved as it reads", async () => {
        const saved = page('Edit me {{ "https://example.com/a_b" | x }} here.');
        const out = await saveAfter(saved, retype("a_b", "c_d"));
        expect(out.text).toBe(page('Edit me {{ "https://example.com/c_d" | x }} here.'));
        expect(out.clean).toBe(true);
    });

    it("a link written as a link inside a directive should stay a link", async () => {
        // Only a bare address is unwrapped; brackets somebody typed are syntax.
        const saved = page("Edit me {{ [x](https://example.com) }} here.");
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.text).toBe(page("Edited me {{ [x](https://example.com) }} here."));
        expect(out.clean).toBe(true);
    });

    it("a serialize outside the save path should keep the strict spelling", async () => {
        // Source-peek, Copy as Markdown, Turn into and the reparse-hazard
        // check use what they serialize without reparsing it first, so they
        // get the spelling that always reopens as the text it came from.
        const editor = await makeCorpusEditor(page("See {{ page.a_b }} here."), [contentGuardPlugin]);
        editors.push(editor);
        expect(editor.action(getMarkdown())).toContain("{{ page.a\\_b }}");
        expect(serializeVerbatim(() => editor.action(getMarkdown())).text).toContain("{{ page.a_b }}");
    });

    it("a document already failing to round-trip should still save directives in the strict spelling", async () => {
        // A parser that never gives the document back stands in for a file
        // already broken some other way: no candidate reopens clean, and the
        // verbatim spelling must not be what reaches disk then.
        const saved = page("Edit me {{ a\\<b }} here.");
        const editor = await makeCorpusEditor(saved, [contentGuardPlugin]);
        editors.push(editor);
        retype("a<b", "c<d")(editor);
        const { text: serialized, verbatim } = serializeVerbatim(() => editor.action(getMarkdown()));
        expect(verbatim).toBe(true);
        const elsewhere = parseWith(editor)("# Something else\n")!;
        const out = mergeVerified(
            saved,
            serialized,
            markdownProfile,
            null,
            editorView(editor).state.doc,
            () => elsewhere,
            () => editor.action(getMarkdown()),
        );
        expect(out.text).toContain("{{ c\\<d }}");
        expect(out.text).not.toContain("{{ c<d }}");
    });

    it("a directive with nothing to escape should not mark the serialize as verbatim", async () => {
        // Nothing for the save path to verify, so it keeps its single-parse road.
        const saved = page("Edit me {{ page.title }} here.");
        const out = await saveAfter(saved, retype("Edit me", "Edited me"));
        expect(out.verbatim).toBe(false);
        expect(out.text).toBe(page("Edited me {{ page.title }} here."));
    });
});
