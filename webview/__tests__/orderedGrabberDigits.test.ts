/**
 * MAR-90: an ordered list's right-aligned ::marker ink widens leftward with its
 * widest number, so the per-item grabber column would sit under the digits once
 * a list reaches 10+ items (or at 150–200% content scale). The gutter pass
 * stamps `--ol-digits` (the digit count of the list's widest number) on the
 * <ol>; the grabber-offset calc() reads it to shift the whole column clear.
 * Single-digit lists (the common case) carry no stamp and pay no cost.
 *
 * Driven through the REAL Milkdown editor + headingFoldPlugin so the decoration
 * actually renders to the DOM, matching production.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin, foldRevealKeymapPlugin } from "../plugins/headingFold";

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<EditorView> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(foldRevealKeymapPlugin)
        .use(pureCommonmark)
        .use(gfm)
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor.ctx.get(editorViewCtx);
}

/** The `--ol-digits` value stamped on the first <ol>, or null if unstamped. */
function olDigits(view: EditorView): string | null {
    const ol = view.dom.querySelector("ol");
    if (!ol) { return null; }
    const style = ol.getAttribute("style") ?? "";
    const m = /--ol-digits:\s*(\d+)/.exec(style);
    return m ? m[1]! : null;
}

function orderedList(count: number, start = 1): string {
    return Array.from({ length: count }, (_, i) => `${start + i}. item ${i + 1}`).join("\n") + "\n";
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("ordered-list grabber digit stamp (MAR-90)", () => {
    it("a single-digit ordered list should carry no --ol-digits stamp", async () => {
        const view = await makeEditor(orderedList(5));
        expect(olDigits(view)).toBeNull();
    });

    it("a list reaching two digits should stamp --ol-digits:2", async () => {
        const view = await makeEditor(orderedList(12));
        expect(olDigits(view)).toBe("2");
    });

    it("a list reaching three digits should stamp --ol-digits:3", async () => {
        const view = await makeEditor(orderedList(100));
        expect(olDigits(view)).toBe("3");
    });

    it("the widest number (not the item count) should set the stamp via `start`", async () => {
        // Nine items, but starting at 95 → 95..103, widest is 3 digits.
        const view = await makeEditor(orderedList(9, 95));
        expect(olDigits(view)).toBe("3");
    });

    it("a bullet list should never be stamped", async () => {
        const view = await makeEditor("- a\n- b\n- c\n");
        // No <ol> at all, so certainly no stamp.
        expect(olDigits(view)).toBeNull();
    });
});
