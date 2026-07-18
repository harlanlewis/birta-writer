/**
 * anchorSync (MAR-180): auto-update in-note `#slug` anchor links when a heading
 * is renamed. Drives the REAL Milkdown editor with the production serialization
 * config and the history + anchorSync plugins registered — no mocks — so the
 * rename detection, the old→new slug diff, the link rewrite, and the single
 * undo step are all exercised against real ProseMirror state and asserted on the
 * SERIALIZED markdown (the on-disk artifact), plus undo.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import { undo } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { historyPlugin } from "../plugins/history";
import { anchorSyncPlugin, headingRangeTouched } from "../plugins/anchorSync";
import { EXTERNAL_SYNC_META } from "../plugins/docChange";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<{ editor: Editor; view: EditorView }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(historyPlugin)
        .use(anchorSyncPlugin)
        .create();
    editors.push(editor);
    const view = editor.action((ctx) => ctx.get(editorViewCtx));
    return { editor, view };
}

const serialize = (editor: Editor): string => editor.action(getMarkdown()).trim();

/** Replace the text of the FIRST heading whose current text === oldText. */
function renameHeading(view: EditorView, oldText: string, newText: string): void {
    let range: { from: number; to: number } | null = null;
    view.state.doc.descendants((node: ProseNode, pos: number, parent) => {
        if (range) return false;
        if (node.isText && node.text === oldText && parent?.type.name === "heading") {
            range = { from: pos, to: pos + node.nodeSize };
            return false;
        }
        return true;
    });
    if (!range) throw new Error(`heading text not found: ${oldText}`);
    const { from, to } = range;
    view.dispatch(view.state.tr.replaceWith(from, to, view.state.schema.text(newText)));
}

/** Every `link` mark href present in the document, in order. */
function linkHrefs(view: EditorView): string[] {
    const hrefs: string[] = [];
    const linkType = view.state.schema.marks["link"];
    view.state.doc.descendants((node) => {
        const m = node.marks.find((mk) => mk.type === linkType);
        if (m) hrefs.push(String(m.attrs["href"]));
    });
    return hrefs;
}

/** Move the Nth (0-based) top-level heading node to the top of the document,
 *  leaving its text untouched — a relocation, not an edit. */
function moveHeadingToTop(view: EditorView, n: number): void {
    const tops: { node: ProseNode; pos: number }[] = [];
    view.state.doc.forEach((node, offset) => {
        if (node.type.name === "heading") tops.push({ node, pos: offset });
    });
    const target = tops[n];
    let tr = view.state.tr.delete(target.pos, target.pos + target.node.nodeSize);
    tr = tr.insert(0, target.node);
    view.dispatch(tr);
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(async () => {
    for (const e of editors) { await e.destroy(); }
    editors = [];
});

describe("anchorSync — rename detection and link rewrite", () => {
    it("renaming a heading with a unique slug should repoint its links and keep the link text", async () => {
        const { editor, view } = await makeEditor(
            "# Old Heading\n\nSee [jump here](#old-heading).\n",
        );
        renameHeading(view, "Old Heading", "New Heading");

        const out = serialize(editor);
        // The href follows the rename; the link TEXT is untouched.
        expect(out).toContain("[jump here](#new-heading)");
        expect(out).toContain("# New Heading");
        // Round-trip: re-serializing the same state is stable (idempotent).
        expect(serialize(editor)).toBe(out);
    });

    it("a body-text edit far from any heading should leave links untouched", async () => {
        const { editor, view } = await makeEditor(
            "# Title\n\nbody text\n\n[go](#title)\n",
        );
        // Edit the body paragraph — no heading in the changed range.
        let from = -1;
        view.state.doc.descendants((n, p, parent) => {
            if (from < 0 && n.isText && n.text === "body text" && parent?.type.name === "paragraph") {
                from = p;
            }
        });
        view.dispatch(view.state.tr.insertText("!", from + "body text".length));

        expect(serialize(editor)).toContain("[go](#title)");
    });

    it("renaming the first of two duplicate headings should update links to BOTH shifted slugs", async () => {
        // First "Foo" is slug foo, second is foo-1. Renaming the FIRST to "Bar"
        // makes the survivor inherit `foo`, so BOTH slugs move:
        //   #foo   → #bar  (the link at the renamed heading)
        //   #foo-1 → #foo  (the link at the survivor, now the base slug)
        const { editor, view } = await makeEditor(
            "# Foo\n\n[a](#foo)\n\n# Foo\n\n[b](#foo-1)\n",
        );
        renameHeading(view, "Foo", "Bar");

        const out = serialize(editor);
        expect(out).toContain("[a](#bar)");
        expect(out).toContain("[b](#foo)");
        // No slug was chained: #foo-1 became #foo, not #bar.
        expect(out).not.toContain("[b](#bar)");
    });

    it("renaming a heading to collide with an existing one should mint the -N slug", async () => {
        // Renaming "Baz" → "Foo" collides with the existing "Foo": the newcomer
        // takes foo-1, so its inbound link #baz → #foo-1 (deterministic).
        const { editor, view } = await makeEditor(
            "# Foo\n\n# Baz\n\n[toBaz](#baz)\n",
        );
        renameHeading(view, "Baz", "Foo");

        expect(serialize(editor)).toContain("[toBaz](#foo-1)");
    });

    it("one undo should restore BOTH the heading text and every rewritten href in a single step", async () => {
        const original = "# Old Heading\n\nSee [jump here](#old-heading).";
        const { editor, view } = await makeEditor(original + "\n");
        renameHeading(view, "Old Heading", "New Heading");
        // Precondition: the rename + rewrite both happened.
        expect(serialize(editor)).toContain("[jump here](#new-heading)");
        expect(serialize(editor)).toContain("# New Heading");

        // A SINGLE undo reverts the whole event — heading AND href together.
        undo(view.state, view.dispatch);

        const out = serialize(editor);
        expect(out).toBe(original);
        expect(out).toContain("# Old Heading");
        expect(out).toContain("[jump here](#old-heading)");
    });

    it("moving a heading without changing its text should rewrite nothing", async () => {
        const { editor, view } = await makeEditor(
            "# Alpha\n\n[toA](#alpha)\n\n# Beta\n\n[toB](#beta)\n",
        );
        moveHeadingToTop(view, 1); // relocate "Beta" above "Alpha"

        const out = serialize(editor);
        // Both anchors are unchanged — a move preserves every slug.
        expect(out).toContain("[toA](#alpha)");
        expect(out).toContain("[toB](#beta)");
    });

    it("deleting a heading should leave its inbound links dangling, not repointed to garbage", async () => {
        const { editor, view } = await makeEditor(
            "# Keep\n\n# Doomed\n\n[toDoomed](#doomed)\n",
        );
        // Delete the whole "Doomed" heading node.
        let target: { pos: number; size: number } | null = null;
        view.state.doc.forEach((node, offset) => {
            if (node.type.name === "heading" && node.textContent === "Doomed") {
                target = { pos: offset, size: node.nodeSize };
            }
        });
        view.dispatch(view.state.tr.delete(target!.pos, target!.pos + target!.size));

        // The link is left EXACTLY as typed (dangling), never rewritten.
        expect(linkHrefs(view)).toEqual(["#doomed"]);
        expect(serialize(editor)).toContain("[toDoomed](#doomed)");
    });

    it("an external-sync rename should NOT trigger a link rewrite (on-disk truth wins)", async () => {
        // A heading rename arriving FROM the file (git checkout, side-by-side
        // text editor) is tagged EXTERNAL_SYNC_META. The file legitimately
        // holds `#title` links alongside the new heading text; "fixing" them
        // would diverge the editor from the file and persist an uncommanded
        // rewrite on the next keystroke.
        const { editor, view } = await makeEditor("# Title\n\n[go](#title)\n");
        let range: { from: number; to: number } | null = null;
        view.state.doc.descendants((node: ProseNode, pos: number, parent) => {
            if (range) return false;
            if (node.isText && node.text === "Title" && parent?.type.name === "heading") {
                range = { from: pos, to: pos + node.nodeSize };
                return false;
            }
            return true;
        });
        if (!range) throw new Error("heading not found");
        const tr = view.state.tr.replaceWith(
            (range as { from: number; to: number }).from,
            (range as { from: number; to: number }).to,
            view.state.schema.text("Renamed"),
        );
        tr.setMeta(EXTERNAL_SYNC_META, true);
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);

        const out = serialize(editor);
        expect(out).toContain("# Renamed");
        // The link keeps the file's bytes — stale, exactly as on disk.
        expect(out).toContain("[go](#title)");
    });

    it("when the feature is disabled the plugin should append nothing", async () => {
        const prev = window.__i18n;
        window.__i18n = { ...(prev ?? { translations: {}, isMac: false }), autoUpdateAnchors: false };
        try {
            const { editor, view } = await makeEditor(
                "# Old Heading\n\n[jump](#old-heading)\n",
            );
            renameHeading(view, "Old Heading", "New Heading");
            // Heading changed, but the link is left dangling — no rewrite ran.
            expect(serialize(editor)).toContain("[jump](#old-heading)");
            expect(serialize(editor)).toContain("# New Heading");
        } finally {
            window.__i18n = prev;
        }
    });
});

describe("headingRangeTouched — the perf guard", () => {
    it("a body-text edit should report NO heading touched (the keystroke fast path)", async () => {
        const { view } = await makeEditor("# Title\n\nbody paragraph here\n");
        let from = -1;
        view.state.doc.descendants((n, p, parent) => {
            if (from < 0 && n.isText && parent?.type.name === "paragraph") from = p;
        });
        const tr = view.state.tr.insertText("x", from + 1);
        expect(headingRangeTouched([tr], view.state.doc)).toBe(false);
    });

    it("an edit inside a heading should report a heading touched", async () => {
        const { view } = await makeEditor("# Title\n\nbody\n");
        let from = -1;
        view.state.doc.descendants((n, p, parent) => {
            if (from < 0 && n.isText && parent?.type.name === "heading") from = p;
        });
        const tr = view.state.tr.insertText("x", from + 1);
        expect(headingRangeTouched([tr], view.state.doc)).toBe(true);
    });

    it("a selection-only transaction should report no heading touched", async () => {
        const { view } = await makeEditor("# Title\n\nbody\n");
        // A transaction with no steps (setMeta only) never changed the doc.
        const tr = view.state.tr.setMeta("noop", true);
        expect(headingRangeTouched([tr], view.state.doc)).toBe(false);
    });
});
