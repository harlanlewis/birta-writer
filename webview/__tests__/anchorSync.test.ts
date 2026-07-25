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

/** A detached level-1 heading node — the payload of a "pasted heading" block
 *  insertion (the MAR-182 path that never goes through a block-type step). */
function makeHeading(view: EditorView, text: string): ProseNode {
    return view.state.schema.nodes["heading"].create({ level: 1 }, view.state.schema.text(text));
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

    it("pasting a COLLIDING heading above an existing one should repoint its links to the shifted slug", async () => {
        // MAR-182. A pure block insertion at a block boundary used to escape the
        // tier-2 guard entirely. The inserted `Foo` takes the base slug `foo`,
        // demoting the ORIGINAL heading to `foo-1` — so a link left pointing at
        // `#foo` silently lands on the newcomer instead of the heading it was
        // written for. The user loses the destination, with no visible edit.
        const { editor, view } = await makeEditor("# Foo\n\n[go](#foo)\n");
        view.dispatch(view.state.tr.insert(0, makeHeading(view, "Foo")));

        const out = serialize(editor);
        expect(out).toContain("[go](#foo-1)");
        expect(out).not.toContain("[go](#foo)");
    });

    it("pasting a colliding heading OVER a selected paragraph should repoint its links too", async () => {
        // The same escape with a NON-empty old range: the replaced range holds
        // only the doomed paragraph, so the pre-edit document never sees the
        // heading either. Only the post-edit range does.
        const { editor, view } = await makeEditor("filler\n\n# Foo\n\n[go](#foo)\n");
        let target: { from: number; to: number } | null = null;
        view.state.doc.forEach((node, offset) => {
            if (!target && node.type.name === "paragraph" && node.textContent === "filler") {
                target = { from: offset, to: offset + node.nodeSize };
            }
        });
        if (!target) throw new Error("filler paragraph not found");
        const { from, to } = target as { from: number; to: number };
        view.dispatch(view.state.tr.replaceWith(from, to, makeHeading(view, "Foo")));

        expect(serialize(editor)).toContain("[go](#foo-1)");
    });

    it("promoting a paragraph into a COLLIDING heading should repoint the demoted heading's links", async () => {
        // The same MAR-182 escape via the far more common gesture: the `# `
        // input rule / gutter promote (setBlockType). The promoted "Foo" takes
        // the base slug, demoting the real heading below it to `foo-1`.
        const { editor, view } = await makeEditor("Foo\n\n# Foo\n\n[go](#foo)\n");
        let para: { from: number; to: number } | null = null;
        view.state.doc.forEach((node, offset) => {
            if (!para && node.type.name === "paragraph" && node.textContent === "Foo") {
                para = { from: offset, to: offset + node.nodeSize };
            }
        });
        if (!para) throw new Error("paragraph not found");
        const { from, to } = para as { from: number; to: number };
        view.dispatch(
            view.state.tr.setBlockType(from + 1, to - 1, view.state.schema.nodes["heading"], {
                level: 1,
            }),
        );

        expect(serialize(editor)).toContain("[go](#foo-1)");
    });

    it("duplicating a section should leave the COPY's self-link pointing at the copy", async () => {
        // The widened guard fires on the insertion, but a link the edit just
        // INSERTED has no pre-edit href to follow: the duplicate's own
        // `[go](#foo)` must keep targeting the duplicate (which holds `foo`),
        // while the ORIGINAL heading's demotion to `foo-1` moves only the link
        // that was already in the document.
        const { editor, view } = await makeEditor("# Foo\n\nSee [go](#foo) here.\n");
        // Duplicate the whole section ABOVE itself, the Shift+Alt+Up shape.
        const section = [] as ProseNode[];
        view.state.doc.forEach((node) => section.push(node));
        view.dispatch(view.state.tr.insert(0, section));

        const out = serialize(editor);
        // Exactly one link per section: the copy keeps #foo, the original's
        // link follows its demoted heading to #foo-1.
        expect(out).toBe("# Foo\n\nSee [go](#foo) here.\n\n# Foo\n\nSee [go](#foo-1) here.");
    });

    it("deleting the FIRST of two duplicate headings should promote the survivor's inbound link", async () => {
        // The old-side half of the guard, asserted on the slug shift it exists
        // for rather than on a dangling link (which survives either way): the
        // survivor inherits the base slug, so #foo-1 must become #foo.
        const { editor, view } = await makeEditor(
            "# Foo\n\n[a](#foo)\n\n# Foo\n\n[b](#foo-1)\n",
        );
        let first: { pos: number; size: number } | null = null;
        view.state.doc.forEach((node, offset) => {
            if (!first && node.type.name === "heading") {
                first = { pos: offset, size: node.nodeSize };
            }
        });
        const { pos, size } = first as unknown as { pos: number; size: number };
        view.dispatch(view.state.tr.delete(pos, pos + size));

        const out = serialize(editor);
        expect(out).toContain("[b](#foo)");
        // The deleted heading's own link is left exactly as typed, never repointed.
        expect(out).toContain("[a](#foo)");
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

describe("anchorSync — the cost of a heading keystroke (MAR-181)", () => {
    /** The doc-mutating steps anchorSync APPENDS to one heading keystroke.
     *  `applyTransaction` returns every transaction in the round, ours first,
     *  so anything past index 0 is the plugin's own contribution — the exact
     *  work the feature costs, counted rather than timed. */
    function appendedStepCount(view: EditorView): number {
        let from = -1;
        view.state.doc.descendants((n, p, parent) => {
            if (from < 0 && n.isText && parent?.type.name === "heading") from = p + 1;
        });
        const { transactions } = view.state.applyTransaction(view.state.tr.insertText("x", from));
        return transactions.slice(1).reduce((n, tr) => n + tr.steps.length, 0);
    }

    it("a heading keystroke with no links pointing at that heading should mutate nothing", async () => {
        // MAR-181 filed this as an O(document) walk per keystroke. Measurement
        // says otherwise: the walk is ~30µs, and with nothing to rewrite the
        // plugin appends NO transaction at all — so document size is not what
        // this feature costs. Pinned as a count of work, not a wall clock.
        const body = Array.from({ length: 120 }, (_, i) => `Body ${i} with [other](#elsewhere).`);
        const { view } = await makeEditor(`# Target\n\n${body.join("\n\n")}\n`);

        expect(appendedStepCount(view)).toBe(0);
    });

    it("a heading keystroke should cost only the links pointing at THAT heading", async () => {
        // The real cost model: proportional to matching links, independent of
        // both document size and the document's total link count. Three links
        // match here and twenty do not, so the appended work must cover three.
        const decoys = Array.from({ length: 20 }, (_, i) => `Decoy ${i}: [d](#other-${i}).`);
        const { editor, view } = await makeEditor(
            `# Target\n\n[a](#target)\n\n[b](#target)\n\n[c](#target)\n\n${decoys.join("\n\n")}\n`,
        );
        // Two mark steps per matching link (remove the stale href, add the new).
        expect(appendedStepCount(view)).toBe(6);

        // And the rewrite itself is correct: the three follow, the twenty don't.
        let from = -1;
        view.state.doc.descendants((n, p, parent) => {
            if (from < 0 && n.isText && parent?.type.name === "heading") from = p + 1;
        });
        view.dispatch(view.state.tr.insertText("X", from));
        const out = serialize(editor);
        expect(out).toContain("[a](#txarget)");
        expect(out).toContain("[c](#txarget)");
        expect(out).toContain("[d](#other-19)");
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

    it("inserting a heading block at a block boundary should report a heading touched", async () => {
        // MAR-182: `fromA === toA` at a boundary, so the PRE-edit document
        // visits nothing — only the post-edit range sees the new heading.
        const { view } = await makeEditor("# Title\n\nbody\n");
        const tr = view.state.tr.insert(0, makeHeading(view, "Inserted"));
        expect(headingRangeTouched([tr], view.state.doc)).toBe(true);
    });

    it("a heading inserted by an EARLIER step of a multi-step transaction should still be seen", async () => {
        // Pins `docs[i + 1] ?? tr.doc` rather than `tr.doc`: step 0's new
        // coordinates are only valid in the doc right AFTER step 0, and step 1
        // shifts everything before it. Reading the transaction's FINAL doc for
        // step 0's range looks somewhere else entirely and misses the heading.
        const { view } = await makeEditor("# Title\n\nbody\n");
        const tr = view.state.tr.insert(0, makeHeading(view, "Inserted"));
        tr.insert(0, view.state.schema.nodes["paragraph"].create(null, view.state.schema.text("x".repeat(200))));
        expect(headingRangeTouched([tr], view.state.doc)).toBe(true);
    });

    it("inserting a paragraph block at a block boundary should still report NO heading touched", async () => {
        // The widened guard must not degrade into "any block insertion is a
        // heading edit" — a pasted paragraph still takes the cheap bail.
        const { view } = await makeEditor("# Title\n\nbody\n");
        const para = view.state.schema.nodes["paragraph"].create(
            null,
            view.state.schema.text("pasted"),
        );
        const tr = view.state.tr.insert(0, para);
        expect(headingRangeTouched([tr], view.state.doc)).toBe(false);
    });

    it("a selection-only transaction should report no heading touched", async () => {
        const { view } = await makeEditor("# Title\n\nbody\n");
        // A transaction with no steps (setMeta only) never changed the doc.
        const tr = view.state.tr.setMeta("noop", true);
        expect(headingRangeTouched([tr], view.state.doc)).toBe(false);
    });
});
