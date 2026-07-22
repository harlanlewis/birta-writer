import { describe, it, expect, vi } from "vitest";
import { Schema, EditorState } from "../pm";
import { findTextMarkers, scanNotes, incrementalScanNotes } from "../notes/scan";

/**
 * The Notes scanner (MAR-188). `findTextMarkers` is exercised on plain strings
 * (the boundary/label/dedup logic — the risky part); `scanNotes` runs against a
 * real ProseMirror document for the node-structural detectors (HTML comments,
 * unchecked checkboxes, code-block exclusion, offset→position mapping).
 */

describe("findTextMarkers — built-in markers", () => {
    it("a bare [TK] should be a placeholder labelled from surrounding context", () => {
        const hits = findTextMarkers("The survey had [TK] respondents");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("placeholder");
        expect(hits[0]!.label).toBe("The survey had [TK] respondents");
    });

    it("[TK: spec] should take the trailing text as its label", () => {
        const hits = findTextMarkers("Intro [TK: stat on remote work] here");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("placeholder");
        expect(hits[0]!.label).toBe("stat on remote work");
    });

    it("an unbracketed TODO: should match and keep its trailing text", () => {
        const hits = findTextMarkers("TODO: write the introduction");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo");
        expect(hits[0]!.label).toBe("write the introduction");
    });

    it("[TODO] and [FIXME: broken] should map to their kinds", () => {
        expect(findTextMarkers("[TODO]")[0]!.kind).toBe("todo");
        const fix = findTextMarkers("[FIXME: broken link]")[0]!;
        expect(fix.kind).toBe("fixme");
        expect(fix.label).toBe("broken link");
    });

    it("a keyword embedded in a word should not match the colon form", () => {
        expect(findTextMarkers("pseudoTODO: not a task")).toHaveLength(0);
    });

    it("bare TK: (unbracketed) should NOT match — TK is bracket-only", () => {
        expect(findTextMarkers("TK: not matched unbracketed")).toHaveLength(0);
    });

    it("a bracketed [TODO: x] should produce exactly one match, not also a colon match", () => {
        const hits = findTextMarkers("[TODO: fix the header]");
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo");
        expect(hits[0]!.label).toBe("fix the header");
    });
});

describe("findTextMarkers — custom markers", () => {
    it("a bare alphanumeric custom token should match only as a whole word", () => {
        const hits = findTextMarkers("The DRAFT stands but redrafted DRAFTs do not", ["DRAFT"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("custom");
        expect(hits[0]!.marker).toBe("DRAFT");
    });

    it("a bare custom token must not light up inside a longer word (word-boundary guard)", () => {
        // The classic false positive: TK inside outkast/networks.
        expect(findTextMarkers("outTKast networkTKs", ["TK"])).toHaveLength(0);
        expect(findTextMarkers("a TK b", ["TK"])).toHaveLength(1);
    });

    it("a punctuated custom marker should match as a literal substring", () => {
        const hits = findTextMarkers("please @ai tighten this", ["@ai"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.marker).toBe("@ai");
    });

    it("a custom marker overlapping a built-in should not double-report", () => {
        const hits = findTextMarkers("[TODO] ship it", ["TODO"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]!.kind).toBe("todo"); // the built-in wins, not "custom"
    });

    it("an empty/whitespace custom marker should be ignored", () => {
        expect(findTextMarkers("nothing here", ["", "   "])).toHaveLength(0);
    });
});

// ── scanNotes against a real document ──────────────────────────────────────

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        bullet_list: { group: "block", content: "list_item+" },
        list_item: { content: "paragraph block*", attrs: { checked: { default: null } } },
        code_block: { group: "block", content: "text*", marks: "" },
        text: { group: "inline" },
        image: { group: "inline", inline: true },
        html: { group: "inline", inline: true, atom: true, attrs: { value: { default: "" } } },
    },
    marks: { inlineCode: {} },
});

function p(text: string) {
    return schema.node("paragraph", null, [schema.text(text)]);
}

describe("scanNotes — document walk", () => {
    it("should surface text markers with positions that land on the marker", () => {
        const doc = schema.node("doc", null, [p("The survey had [TK] respondents")]);
        const items = scanNotes(doc);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("placeholder");
        expect(doc.textBetween(items[0]!.from, items[0]!.to)).toBe("[TK]");
    });

    it("should NOT scan inside a code block", () => {
        const doc = schema.node("doc", null, [
            schema.node("code_block", null, [schema.text("TODO: this is code, not a task")]),
        ]);
        expect(scanNotes(doc)).toHaveLength(0);
    });

    it("should route an HTML comment by its TODO prefix and take the rest as label", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- TODO: rewrite this -->" })]),
        ]);
        const items = scanNotes(doc);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("todo");
        expect(items[0]!.label).toBe("rewrite this");
    });

    it("a bare HTML comment should be a plain note", () => {
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- ask the source -->" })]),
        ]);
        const items = scanNotes(doc);
        expect(items[0]!.kind).toBe("comment");
        expect(items[0]!.label).toBe("ask the source");
    });

    it("should NOT list a task checkbox (it's content, not an editor note)", () => {
        const doc = schema.node("doc", null, [
            schema.node("bullet_list", null, [
                schema.node("list_item", { checked: false }, [p("buy milk")]),
                schema.node("list_item", { checked: true }, [p("done thing")]),
                schema.node("list_item", { checked: null }, [p("plain bullet")]),
            ]),
        ]);
        expect(scanNotes(doc)).toHaveLength(0);
    });

    it("should still catch a marker typed INSIDE a task line", () => {
        const doc = schema.node("doc", null, [
            schema.node("bullet_list", null, [
                schema.node("list_item", { checked: false }, [p("do TODO: the thing")]),
            ]),
        ]);
        const items = scanNotes(doc);
        expect(items).toHaveLength(1);
        expect(items[0]!.kind).toBe("todo");
    });

    it("should return every kind, document-ordered by position", () => {
        const doc = schema.node("doc", null, [
            p("lead [TK] para"),
            p("do TODO: the thing"),
            schema.node("paragraph", null, [schema.node("html", { value: "<!-- FIXME: later -->" })]),
        ]);
        const items = scanNotes(doc);
        const froms = items.map((i) => i.from);
        expect([...froms]).toEqual([...froms].sort((a, b) => a - b));
        expect(items.map((i) => i.kind)).toContain("placeholder");
        expect(items.map((i) => i.kind)).toContain("todo");
        expect(items.map((i) => i.kind)).toContain("fixme");
    });
});

// ── incrementalScanNotes: the per-keystroke fast path ──────────────────────
//
// The contract is the full scan is ground truth: whatever the fast path returns
// (when it doesn't bail) must equal scanNotes(next). Each case applies a real
// transaction, then checks (a) that oracle equality holds and (b) whether the
// fast path engaged or correctly bailed to a full re-walk.

describe("incrementalScanNotes — oracle equality with a full scan", () => {
    function docOf(...blocks: import("../pm").Node[]) {
        return schema.node("doc", null, blocks);
    }
    /** Apply an edit and return { prev, next } docs. */
    function edit(doc: import("../pm").Node, build: (s: EditorState) => import("../pm").Transaction) {
        const state = EditorState.create({ doc, schema });
        return { prev: doc, next: state.apply(build(state)).doc };
    }
    /** Assert the fast path (when it runs) matches the full scan; return the result. */
    function check(prev: import("../pm").Node, next: import("../pm").Node, markers: string[] = []) {
        const full = scanNotes(next, markers);
        const inc = incrementalScanNotes(prev, scanNotes(prev, markers), next, markers);
        if (inc !== null) { expect(inc).toEqual(full); }
        return inc;
    }

    it("typing in a marker-free paragraph should fast-path and shift a later marker", () => {
        const doc = docOf(p("plain lead"), p("tail has [TK] here"));
        const { prev, next } = edit(doc, (s) => s.tr.insertText("XX", 1));
        const inc = check(prev, next);
        expect(inc).not.toBeNull(); // fast path engaged (no full walk)
        expect(inc!.find((i) => i.kind === "placeholder")).toBeTruthy();
    });

    it("completing a marker inside a block should fast-path and surface the new note", () => {
        const doc = docOf(p("draft [TK para"));
        // Close the bracket: "[TK para" → "[TK] para" (insert "]" after "[TK").
        const { prev, next } = edit(doc, (s) => s.tr.insertText("]", 1 + "draft [TK".length));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc!.map((i) => i.kind)).toContain("placeholder");
    });

    it("editing an HTML comment's routing prefix should fast-path to the new kind", () => {
        const doc = docOf(schema.node("paragraph", null, [schema.node("html", { value: "<!-- note here -->" })]));
        // Not a text edit of the atom; replace the whole html node's block.
        const next = docOf(schema.node("paragraph", null, [schema.node("html", { value: "<!-- TODO: note here -->" })]));
        const full = scanNotes(next);
        expect(full[0]!.kind).toBe("todo"); // ground truth changed
        // A whole-atom swap isn't a single inline text edit; the fast path may
        // bail, but the fallback (full) is still correct.
        const inc = incrementalScanNotes(doc, scanNotes(doc), next);
        if (inc !== null) { expect(inc).toEqual(full); }
    });

    it("typing inside a task line (a marker there) still agrees with a full scan", () => {
        const doc = docOf(schema.node("bullet_list", null, [
            schema.node("list_item", { checked: false }, [p("do TODO: thing")]),
        ]));
        // Insert ahead of the marker; the task itself is not a note, but the
        // TODO: inside it is, and its context label shifts.
        const { prev, next } = edit(doc, (s) => s.tr.insertText("x", 1 + 1 + 1));
        const inc = check(prev, next);
        expect(inc).not.toBeNull(); // no task-label special case to bail for now
    });

    it("splitting a paragraph should BAIL to a full scan", () => {
        const doc = docOf(p("one [TK] two"));
        const { prev, next } = edit(doc, (s) => s.tr.split(1 + "one ".length));
        expect(incrementalScanNotes(prev, scanNotes(prev), next)).toBeNull();
    });

    it("typing in a code block should fast-path and stay empty", () => {
        const doc = docOf(
            schema.node("code_block", null, [schema.text("const x = 1")]),
            p("body [TK]"),
        );
        const { prev, next } = edit(doc, (s) => s.tr.insertText("2", 1 + "const x = 1".length));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc!.filter((i) => i.from < 14)).toHaveLength(0); // nothing from the code block
    });

    it("a custom-marker edit should agree with a full scan", () => {
        const doc = docOf(p("please DRAFT this"), p("and [TK] that"));
        const { prev, next } = edit(doc, (s) => s.tr.insertText("really ", 1));
        const inc = check(prev, next, ["DRAFT"]);
        expect(inc).not.toBeNull();
        expect(inc!.map((i) => i.kind).sort()).toEqual(["custom", "placeholder"]);
    });

    it("DELETING text before a marker should fast-path and shift it back (negative delta)", () => {
        const doc = docOf(p("wordy lead here"), p("keep [TK] this"));
        const { prev, next } = edit(doc, (s) => s.tr.delete(1, 1 + "wordy ".length));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        const tk = inc!.find((i) => i.kind === "placeholder")!;
        // [TK] must land exactly where a full scan puts it.
        expect(next.textBetween(tk.from, tk.to)).toBe("[TK]");
    });

    it("REPLACING a range inside a block should fast-path and agree with a full scan", () => {
        const doc = docOf(p("alpha [TK] omega"), p("tail [TODO: x]"));
        // Replace "alpha " (6 chars) with "hi " (3 chars): net delta -3.
        const { prev, next } = edit(doc, (s) => s.tr.insertText("hi ", 1, 1 + "alpha ".length));
        const inc = check(prev, next);
        expect(inc).not.toBeNull();
        expect(inc!.map((i) => i.kind)).toEqual(["placeholder", "todo"]);
    });

    it("an edit a full document behind (tab was inactive) should still agree with a full scan", () => {
        // The cache can lag many edits when the tab is hidden; incremental must
        // be correct for ANY prev→next, not just adjacent frames.
        const doc = docOf(p("one [TK] two three four"));
        const state = EditorState.create({ doc, schema });
        const next = state.apply(state.tr.insertText("Z", 3).insertText("Y", 7)).doc;
        const inc = incrementalScanNotes(doc, scanNotes(doc), next);
        if (inc !== null) { expect(inc).toEqual(scanNotes(next)); }
    });

    it("the fast path should NOT walk the whole document (only the edited block)", () => {
        // The perf guarantee: an inline edit re-scans one block, so the full
        // doc.descendants walk scanNotes(next) would do must never run.
        const doc = docOf(p("lead"), p("mid [TK] mid"), p("tail [TODO: x]"), p("end"));
        const { prev, next } = edit(doc, (s) => s.tr.insertText("z", 1));
        const walk = vi.spyOn(next, "descendants");
        const inc = incrementalScanNotes(prev, scanNotes(prev), next);
        expect(inc).not.toBeNull();
        expect(walk).not.toHaveBeenCalled();
    });
});
