/**
 * Autolink backslash escapes are bounded (MAR-218).
 *
 * `mdast-util-to-markdown` backslash-escapes `\` inside an angle-bracket
 * autolink, but CommonMark says backslash escapes are INERT there — so the
 * parser never unescapes and every save doubled what the last one wrote:
 * `see https://e.com/a\ ok` became `<https://e.com/a\\>`, then `\\\\`, then
 * `\\\\\\\\`, ×2 per open-and-save cycle, without bound. The zero-edit save was
 * protected by the merge layer, so it only started growing once the line had
 * been touched — and then grew forever.
 *
 * Two layers of coverage: the pure post-pass function (shape anchoring, and
 * everything it must REFUSE to touch), and the real Milkdown editor driven
 * through repeated save cycles to prove the growth has a fixed point.
 */
import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import {
    applyMinimalChanges,
    computeRoundTripProtection,
    unescapeAutolinkBackslashes,
} from "../utils/minimalDiff";

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
        .use(gfmFidelity)
        .create();
}

/** One open → edit → merge → save cycle, exactly as the sync pipeline runs it. */
async function editAndSave(content: string, anchor: string): Promise<string> {
    const editor = await makeEditor(content);
    const baseline = editor.action(getMarkdown());
    const protection = computeRoundTripProtection(content, baseline);
    const v: EditorView = editor.action((ctx) => ctx.get(editorViewCtx));
    let at = -1;
    v.state.doc.descendants((node, pos) => {
        if (at >= 0) return false;
        if (node.isText && node.text?.includes(anchor)) {
            at = pos + (node.text?.indexOf(anchor) ?? 0);
            return false;
        }
        return true;
    });
    if (at < 0) throw new Error(`anchor not found: ${anchor}`);
    v.dispatch(v.state.tr.insertText("Q", at));
    const merged = applyMinimalChanges(content, editor.action(getMarkdown()), protection);
    await editor.destroy();
    return merged;
}

/** How many backslashes the document contains, in total. */
function backslashes(text: string): number {
    return (text.match(/\\/g) ?? []).length;
}

describe("autolink backslash escapes reach a fixed point", () => {
    it("repeated edit-and-save cycles on a bare URL should stop doubling", async () => {
        // Arrange — the reported case: a bare URL whose path ends in a
        // backslash, in ordinary prose.
        let doc = "see https://e.com/a\\ ok\n";

        // Act — three full cycles, each editing the line (which is what
        // unprotects it and lets the serializer's own bytes land).
        const counts: number[] = [];
        for (let i = 0; i < 3; i++) {
            doc = await editAndSave(doc, "ok");
            counts.push(backslashes(doc));
        }

        // Assert — the count settles instead of doubling (1 → 2 → 4 → 8).
        expect(counts[0]).toBeLessThanOrEqual(1);
        expect(counts[1]).toBe(counts[0]);
        expect(counts[2]).toBe(counts[0]);
    });

    it("an angle autolink carrying a backslash should round-trip byte-identically", async () => {
        // Arrange
        const content = "see <https://e.com/a\\> ok\n";

        // Act
        const editor = await makeEditor(content);
        const serialized = editor.action(getMarkdown());
        await editor.destroy();

        // Assert — no doubling at all, so no protection region is needed.
        expect(serialized).toBe(content);
        expect(computeRoundTripProtection(content, serialized)).toBeNull();
    });

    it("an email autolink should be unaffected", async () => {
        const content = "mail <bob@e.com> ok\n";

        const editor = await makeEditor(content);
        const serialized = editor.action(getMarkdown());
        await editor.destroy();

        expect(serialized).toBe(content);
    });
});

describe("the post-pass only touches serializer-produced autolink escapes", () => {
    it("an even backslash run inside an autolink should halve", () => {
        expect(unescapeAutolinkBackslashes("see <https://e.com/a\\\\> ok")).toBe(
            "see <https://e.com/a\\> ok",
        );
        expect(unescapeAutolinkBackslashes("see <https://e.com/a\\\\\\\\> ok")).toBe(
            "see <https://e.com/a\\\\> ok",
        );
    });

    it("several separate runs in one autolink should each halve", () => {
        expect(unescapeAutolinkBackslashes("<https://e.com/a\\\\b\\\\\\\\c>")).toBe(
            "<https://e.com/a\\b\\\\c>",
        );
    });

    it("an ODD backslash run should be refused outright", () => {
        // The serializer can only ever emit even runs (a model run of N prints
        // as 2N), so an odd run is not ours to rewrite.
        const odd = "see <https://e.com/a\\\\\\> ok";
        expect(unescapeAutolinkBackslashes(odd)).toBe(odd);
    });

    it("a single backslash — the already-stable form — should be left alone", () => {
        const stable = "see <https://e.com/a\\> ok";
        expect(unescapeAutolinkBackslashes(stable)).toBe(stable);
    });

    it("a link DESTINATION literal should keep its doubling", () => {
        // Backslash escapes ARE live in a link destination, so halving them
        // would change the URL.
        const dest = "[x](<https://e.com/a b\\\\>)";
        expect(unescapeAutolinkBackslashes(dest)).toBe(dest);
    });

    it("an escaped literal angle bracket in prose should be left alone", () => {
        const literal = "prose \\<https://e.com/a\\\\> more";
        expect(unescapeAutolinkBackslashes(literal)).toBe(literal);
    });

    it("content inside a fenced code block should be left alone", () => {
        const fenced = "```\n<file:C:\\\\path\\\\to>\n```\n";
        expect(unescapeAutolinkBackslashes(fenced)).toBe(fenced);
    });

    it("content inside an inline code span should be left alone", () => {
        const span = "run `<file:C:\\\\path>` now";
        expect(unescapeAutolinkBackslashes(span)).toBe(span);
    });

    it("an autolink outside a code span on the same line should still be fixed", () => {
        expect(unescapeAutolinkBackslashes("`code` and <https://e.com/a\\\\> end")).toBe(
            "`code` and <https://e.com/a\\> end",
        );
    });

    it("a non-URI angle construct should never match", () => {
        // No scheme, so it is not an autolink — raw HTML, or literal text.
        const html = "<span data-x=\"a\\\\b\">";
        expect(unescapeAutolinkBackslashes(html)).toBe(html);
    });

    it("a document with no doubled backslash should be returned unchanged", () => {
        const plain = "just <https://e.com/a> and prose\n";
        expect(unescapeAutolinkBackslashes(plain)).toBe(plain);
    });
});
