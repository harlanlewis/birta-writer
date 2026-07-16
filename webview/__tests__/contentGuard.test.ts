/**
 * Tests for the content-conservation guard (MAR-108): the fingerprint
 * function's properties, the veto contracts for tagged moves/duplicates, the
 * warn-only conversion audit, the native-drop gating (in-document move
 * conservation + folded-target veto), and the appendTransaction escape-hatch
 * invariant (no normalizer may touch content bytes).
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config) with the guard plugin registered, exactly like the
 * browser. acquireVsCodeApi is injected by setup.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { TextSelection } from "@milkdown/prose/state";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { headingFoldPlugin, headingFoldPluginKey } from "../plugins/headingFold";
import { historyPlugin } from "../plugins/history";
import { insertCalloutCommand } from "../plugins/callouts";
import { listSpreadNormalizePlugin } from "../plugins/list";
import { mathInlineEditPlugin } from "../plugins/mathInlineEdit";
import { trailingHrParagraphPlugin as hrTrailingPlugin } from "../plugins/horizontalRule";
import {
    checkConversion,
    contentGuardPlugin,
    diffFingerprints,
    fingerprintDoc,
    formatFingerprintDiff,
    tagContentGuard,
} from "../plugins/contentGuard";
import { moveBlockTo, moveRangeAt, setBlockMenuContext } from "../components/blockMenu";
import { convertAt } from "../blockCapabilities";
import { flashRange } from "../components/blockMenu/rangeIndicator";

// The landing flash is a geometry no-op under jsdom; mock it so the veto
// path's "skip the flash" contract is observable.
vi.mock("../components/blockMenu/rangeIndicator", () => ({
    flashRange: vi.fn(),
    showRangeVeil: vi.fn(),
    hideRangeVeil: vi.fn(),
}));

let editors: Editor[] = [];
let activeEditor: Editor | null = null;

setBlockMenuContext({ getEditor: () => activeEditor });

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(headingFoldPlugin)
        .use(historyPlugin)
        .use(insertCalloutCommand)
        .use(contentGuardPlugin)
        .create();
    editors.push(editor);
    activeEditor = editor;
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function markdown(editor: Editor): string {
    return editor.action(getMarkdown()).trim();
}

/** Position of the first block whose text matches, or -1. */
function blockPos(v: EditorView, text: string, type?: string): number {
    let found = -1;
    v.state.doc.descendants((node: ProseNode, pos: number) => {
        if (found === -1 && node.textContent === text && (!type || node.type.name === type)) {
            found = pos;
        }
        return found === -1;
    });
    return found;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

/** The [ContentGuard] console.error lines emitted so far. */
function guardErrors(): string[] {
    return errorSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("[ContentGuard]"));
}

beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
    errorSpy.mockRestore();
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    activeEditor = null;
    document.body.innerHTML = "";
});

// ── Fingerprint properties ──────────────────────────────────────────────────

describe("fingerprintDoc", () => {
    it("a legal block move should conserve the fingerprint exactly", async () => {
        const editor = await makeEditor("Alpha\n\nBravo\n\nCharlie");
        const v = view(editor);
        const before = fingerprintDoc(v.state.doc);
        const range = moveRangeAt(v, blockPos(v, "Bravo"))!;
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(new Map(fingerprintDoc(v.state.doc))).toEqual(new Map(before));
    });

    it("block order should not affect the fingerprint (reorder invariance)", async () => {
        const a = await makeEditor("One\n\n> [!NOTE] T\n> quoted\n\n- item");
        const b = await makeEditor("- item\n\nOne\n\n> [!NOTE] T\n> quoted");
        expect(new Map(fingerprintDoc(view(a).state.doc)))
            .toEqual(new Map(fingerprintDoc(view(b).state.doc)));
    });

    it("callout marker bytes should change the fingerprint even with identical text", async () => {
        const note = await makeEditor("> [!NOTE]\n> body");
        const tip = await makeEditor("> [!TIP]\n> body");
        const delta = diffFingerprints(
            fingerprintDoc(view(note).state.doc),
            fingerprintDoc(view(tip).state.doc),
        );
        expect([...delta.lost.keys()].some((k) => k.startsWith("marker:callout:"))).toBe(true);
        expect([...delta.gained.keys()].some((k) => k.startsWith("marker:callout:"))).toBe(true);
    });

    it("a text-less node (hr) should still register through its type count", async () => {
        const withHr = await makeEditor("text\n\n---");
        const without = await makeEditor("text");
        const delta = diffFingerprints(
            fingerprintDoc(view(withHr).state.doc),
            fingerprintDoc(view(without).state.doc),
        );
        expect(delta.lost.get("count:hr")).toBe(1);
    });

    it("diffFingerprints of identical docs should be empty and format as (none)", async () => {
        const editor = await makeEditor("same\n\ndoc");
        const fp = fingerprintDoc(view(editor).state.doc);
        const delta = diffFingerprints(fp, fp);
        expect(delta.lost.size).toBe(0);
        expect(delta.gained.size).toBe(0);
        expect(formatFingerprintDiff(delta)).toBe("lost: (none); gained: (none)");
    });
});

describe("checkConversion — conserving-modulo-marks tier", () => {
    it("marked text flattened into a fence (bytes added) should pass", async () => {
        const before = await makeEditor("foo **bar**");
        const after = await makeEditor("```\nfoo **bar**\n```");
        expect(
            checkConversion(
                view(before).state.doc,
                view(after).state.doc,
                "conserving-modulo-marks",
            ),
        ).toBeNull();
    });

    it("text bytes missing from the flattened result should be a violation", async () => {
        const before = await makeEditor("foo **bar**");
        const after = await makeEditor("```\nfoo\n```");
        expect(
            checkConversion(
                view(before).state.doc,
                view(after).state.doc,
                "conserving-modulo-marks",
            ),
        ).toMatch(/lost text/);
    });
});

// ── Tagged moves and duplicates: veto mode ──────────────────────────────────

describe("guard veto — tagged moves", () => {
    it("a synthetic lossy move transaction should be vetoed and the doc unchanged", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        const pos = blockPos(v, "Bravo");
        const node = v.state.doc.nodeAt(pos)!;
        // The B1/B2 failure shape: the delete half committed alone.
        const tr = v.state.tr.deleteRange(pos, pos + node.nodeSize);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("move blocked"))).toBe(true);
    });

    it("a veto should surface the quiet notice element", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const pos = blockPos(v, "Bravo");
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.deleteRange(pos, pos + node.nodeSize);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        const notice = document.querySelector(".content-guard-notice");
        expect(notice).not.toBeNull();
        expect(notice!.classList.contains("content-guard-notice--visible")).toBe(true);
        expect(notice!.textContent).not.toBe("");
    });

    it("a code-block interior target should be refused by the primitive BEFORE the guard fires", async () => {
        // The latent bug the guard exposed: an interior target inside a code
        // block "fits" by SPLITTING the block (the size check passes), so
        // before MAR-108 this committed a mangled document. Since MAR-112 the
        // move primitive's explicit-fit check refuses it pre-transaction —
        // the guard (which used to veto it as the last line of defense)
        // never even sees a transaction.
        const editor = await makeEditor("Alpha\n\n```js\nconst x = 1;\n```");
        const v = view(editor);
        const before = markdown(editor);
        let codeTextPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (node.type.name === "code_block") codeTextPos = pos + 3;
            return codeTextPos === -1;
        });
        const range = moveRangeAt(v, 0)!;
        vi.mocked(flashRange).mockClear();
        expect(moveBlockTo(v, range, codeTextPos)).toBe(false);
        expect(markdown(editor)).toBe(before);
        expect(flashRange).not.toHaveBeenCalled();
        // Refused structurally, loudly, upstream of the guard: a [moveBlocks]
        // diagnostic, and NO [ContentGuard] veto.
        expect(guardErrors()).toEqual([]);
        expect(
            errorSpy.mock.calls.some((args) => String(args[0]).includes("[moveBlocks]")),
        ).toBe(true);
    });

    it("a tagged move that unwraps a titled callout should be vetoed", async () => {
        // The overbroad-exemption shape: children survive, but the wrapper
        // and its marker line — carrying the user's title bytes, which live
        // nowhere else in the doc — vanish. The DISSOLVABLE exemption must
        // not forgive a NON-default marker.
        const editor = await makeEditor("> [!NOTE] Keep me\n> body");
        const v = view(editor);
        const before = markdown(editor);
        const pos = blockPos(v, "body", "callout");
        expect(pos).toBeGreaterThan(-1);
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.replaceWith(pos, pos + node.nodeSize, node.content);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("move blocked"))).toBe(true);
    });

    it("a move that dissolves a bare-marker callout should still apply", async () => {
        // Genuine dissolution: the marker is the default `[!kind]` shape with
        // no title — no user bytes beyond the container's existence.
        const editor = await makeEditor("> [!NOTE]\n> body");
        const v = view(editor);
        const pos = blockPos(v, "body", "callout");
        expect(pos).toBeGreaterThan(-1);
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.replaceWith(pos, pos + node.nodeSize, node.content);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        expect(markdown(editor)).toBe("body");
        expect(guardErrors()).toEqual([]);
    });

    it("a tagged move that synthesizes a content-bearing paragraph should be vetoed", async () => {
        // A move conserves content, so gaining a paragraph with text is a bug.
        // (Empty paragraphs are non-content — the fingerprint no longer counts
        // them, MAR-123 — so this exercises a CONTENT gain, the real invariant.)
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const docBefore = v.state.doc;
        const synthesized = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text("synthesized"),
        );
        const tr = v.state.tr.insert(0, synthesized);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        expect(v.state.doc).toBe(docBefore);
        expect(guardErrors().some((line) => line.includes("move blocked"))).toBe(true);
    });

    it("a tagged move that synthesizes only empty paragraphs should apply (non-content)", async () => {
        // Empty paragraphs carry no bytes and vanish on save (MAR-123), so
        // creating them is not a conservation violation — the guard must not
        // veto a move whose only "gain" is contentless paragraphs.
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const docBefore = v.state.doc;
        const para = v.state.schema.nodes["paragraph"]!.create();
        const tr = v.state.tr.insert(0, para).insert(0, para);
        tagContentGuard(tr, { kind: "move" });
        v.dispatch(tr);
        expect(v.state.doc).not.toBe(docBefore); // applied, not vetoed
        expect(v.state.doc.childCount).toBe(docBefore.childCount + 2);
        expect(guardErrors()).toEqual([]);
    });

    it("a legal move should flash its landing and report success", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const range = moveRangeAt(v, blockPos(v, "Alpha"))!;
        vi.mocked(flashRange).mockClear();
        expect(moveBlockTo(v, range, v.state.doc.content.size)).toBe(true);
        expect(markdown(editor)).toBe("Bravo\n\nAlpha");
        expect(flashRange).toHaveBeenCalledTimes(1);
        expect(guardErrors()).toEqual([]);
    });
});

describe("guard veto — tagged duplicates", () => {
    it("a duplicate whose gain differs from its declaration should be vetoed", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        const alpha = v.state.doc.nodeAt(blockPos(v, "Alpha"))!;
        const junk = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text("junk"),
        );
        // Inserts junk but declares a copy of Alpha — the B7 shape (content
        // gained that the operation never promised).
        const tr = v.state.tr.insert(0, junk);
        tagContentGuard(tr, { kind: "duplicate", gained: alpha.content });
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("duplicate blocked"))).toBe(true);
    });

    it("a duplicate gaining exactly the declared copy should apply", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const pos = blockPos(v, "Alpha");
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.insert(pos + node.nodeSize, node);
        tagContentGuard(tr, { kind: "duplicate", gained: node });
        v.dispatch(tr);
        expect(markdown(editor)).toBe("Alpha\n\nAlpha\n\nBravo");
        expect(guardErrors()).toEqual([]);
    });
});

// ── Conversions: warn-only ──────────────────────────────────────────────────

describe("guard audit — conversions", () => {
    it("callout → blockquote (declared marker drop, title rescued) should not warn", async () => {
        const editor = await makeEditor("> [!NOTE] Title\n> body");
        const v = view(editor);
        const pos = blockPos(v, "body", "callout");
        expect(pos).toBeGreaterThan(-1);
        expect(convertAt(v, pos, "blockquote", () => activeEditor)).toBe(true);
        expect(markdown(editor)).toContain("> Title");
        expect(guardErrors()).toEqual([]);
    });

    it("paragraph with marks → code block (conserving-modulo-marks) should not warn", async () => {
        const editor = await makeEditor("foo **bar**");
        const v = view(editor);
        expect(convertAt(v, 0, "codeBlock", () => activeEditor)).toBe(true);
        expect(markdown(editor)).toContain("foo **bar**");
        expect(guardErrors()).toEqual([]);
    });

    it("an undeclared marker loss in a tagged convert should warn but still apply", async () => {
        const editor = await makeEditor("> [!NOTE] Title\n> body");
        const v = view(editor);
        const pos = blockPos(v, "body", "callout");
        const node = v.state.doc.nodeAt(pos)!;
        const quote = v.state.schema.nodes["blockquote"]!.create(null, node.content);
        // Claims to be conserving while destroying the callout marker line —
        // the B6 shape.
        const tr = v.state.tr.replaceWith(pos, pos + node.nodeSize, quote);
        tagContentGuard(tr, { kind: "convert", effect: "conserving" });
        v.dispatch(tr);
        expect(markdown(editor)).not.toContain("[!NOTE]"); // warn-only: it applied
        expect(
            guardErrors().some((line) => line.includes("dropped undeclared marker")),
        ).toBe(true);
    });
});

// ── Native drop gating ──────────────────────────────────────────────────────

describe("guard veto — native drops", () => {
    async function makeFolded(): Promise<{
        editor: Editor;
        v: EditorView;
        headingEnd: number;
        sectionEnd: number;
    }> {
        const editor = await makeEditor("Intro\n\n## Section\n\nBody one\n\n## Next\n\nAfter");
        const v = view(editor);
        let hPos = -1;
        let hEnd = -1;
        let sectionEnd = -1;
        v.state.doc.forEach((node: ProseNode, offset: number) => {
            if (node.type.name === "heading" && node.textContent === "Section") {
                hPos = offset;
                hEnd = offset + node.nodeSize;
            }
            if (node.type.name === "heading" && node.textContent === "Next") {
                sectionEnd = offset;
            }
        });
        expect(hPos).toBeGreaterThan(-1);
        v.dispatch(v.state.tr.setMeta(headingFoldPluginKey, { type: "toggle", pos: hPos }));
        expect(headingFoldPluginKey.getState(v.state)!.folded.has(hPos)).toBe(true);
        return { editor, v, headingEnd: hEnd, sectionEnd };
    }

    function dropParagraph(v: EditorView, at: number, text: string): void {
        const para = v.state.schema.nodes["paragraph"]!.create(null, v.state.schema.text(text));
        v.dispatch(v.state.tr.insert(at, para).setMeta("uiEvent", "drop"));
    }

    it("a drop landing inside a folded section should be vetoed", async () => {
        const { editor, v, headingEnd } = await makeFolded();
        const before = markdown(editor);
        dropParagraph(v, headingEnd, "vanisher");
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("folded"))).toBe(true);
    });

    it("a drop at the visible boundary after a folded section should apply", async () => {
        const { editor, v, sectionEnd } = await makeFolded();
        dropParagraph(v, sectionEnd, "lander");
        expect(markdown(editor)).toContain("lander");
        expect(guardErrors()).toEqual([]);
    });

    it("a conserving in-document move drop should apply", async () => {
        const editor = await makeEditor("Alpha\n\nBravo\n\nCharlie");
        const v = view(editor);
        const pos = blockPos(v, "Bravo");
        const node = v.state.doc.nodeAt(pos)!;
        // PM's move-drop shape: delete the dragged slice, insert at the drop
        // point, one transaction, uiEvent: "drop".
        const tr = v.state.tr.delete(pos, pos + node.nodeSize);
        tr.insert(0, node).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toBe("Bravo\n\nAlpha\n\nCharlie");
        expect(guardErrors()).toEqual([]);
    });

    it("an in-document move drop that gains extra content should be vetoed (MAR-36 class)", async () => {
        const editor = await makeEditor("Alpha\n\nBravo\n\nCharlie");
        const v = view(editor);
        const before = markdown(editor);
        const pos = blockPos(v, "Bravo");
        const node = v.state.doc.nodeAt(pos)!;
        const junk = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text("leaked payload"),
        );
        const tr = v.state.tr.delete(pos, pos + node.nodeSize);
        tr.insert(0, node).insert(0, junk).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("gained"))).toBe(true);
    });

    it("a move drop that discards a hardbreak should be vetoed", async () => {
        // hardbreak carries no text bytes and no attrs, so without an atom
        // entry it is count-only — and counts are drop-exempt. A move-drop
        // into a context that discards the hard line break must veto.
        const editor = await makeEditor("one\\\ntwo\n\nAfter");
        const v = view(editor);
        const before = markdown(editor);
        const pos = blockPos(v, "one\ntwo"); // hardbreak leaf text is "\n"
        expect(pos).toBeGreaterThan(-1);
        const node = v.state.doc.nodeAt(pos)!;
        const flat = v.state.schema.nodes["paragraph"]!.create(
            null,
            v.state.schema.text("onetwo"),
        );
        const tr = v.state.tr.delete(pos, pos + node.nodeSize);
        tr.insert(0, flat).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(
            guardErrors().some((line) => line.includes("atom:hardbreak")),
        ).toBe(true);
    });

    it("a move drop that preserves a hardbreak should apply", async () => {
        const editor = await makeEditor("one\\\ntwo\n\nAfter");
        const v = view(editor);
        const pos = blockPos(v, "one\ntwo"); // hardbreak leaf text is "\n"
        expect(pos).toBeGreaterThan(-1);
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.delete(pos, pos + node.nodeSize);
        tr.insert(v.state.doc.content.size - node.nodeSize, node).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toContain("one");
        expect(guardErrors()).toEqual([]);
    });

    it("an external insert-only drop (intentional gain) should apply untouched", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        dropParagraph(v, 0, "from outside");
        expect(markdown(editor)).toBe("from outside\n\nAlpha\n\nBravo");
        expect(guardErrors()).toEqual([]);
    });

    it("a drop that loses content should be vetoed even without a move shape", async () => {
        const editor = await makeEditor("Alpha\n\nBravo");
        const v = view(editor);
        const before = markdown(editor);
        const pos = blockPos(v, "Bravo");
        const node = v.state.doc.nodeAt(pos)!;
        const tr = v.state.tr.delete(pos, pos + node.nodeSize).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
        expect(guardErrors().some((line) => line.includes("lost"))).toBe(true);
    });

    it("a conserving drop that nests an aside inside an aside should be refused (MAR-120 F)", async () => {
        // ProseMirror's native drag of a selected block doesn't route through
        // moveBlocks, so the save-survival refusal must also hold on the
        // uiEvent:"drop" path: this drop conserves content exactly (the
        // fingerprint passes), but the nested <aside> cannot survive
        // save+reopen — the reopened file loses the inner aside's text.
        const editor = await makeEditor(
            "<aside>\n💡 Outer body.\n</aside>\n\n<aside>\n🐛 Inner mover.\n</aside>",
        );
        const v = view(editor);
        const before = markdown(editor);
        let innerPos = -1;
        let outerPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (node.type.name === "notion_callout") {
                if (node.textContent.includes("Inner mover")) innerPos = pos;
                if (node.textContent.includes("Outer body")) outerPos = pos;
                return false;
            }
            return true;
        });
        expect(innerPos).toBeGreaterThan(-1);
        const inner = v.state.doc.nodeAt(innerPos)!;
        const outer = v.state.doc.nodeAt(outerPos)!;
        // In-document move shape: delete + insert at the outer aside's last
        // inner boundary, one transaction, uiEvent: "drop".
        const tr = v.state.tr.delete(innerPos, innerPos + inner.nodeSize);
        tr.insert(tr.mapping.map(outerPos + outer.nodeSize - 1), inner).setMeta("uiEvent", "drop");
        v.dispatch(tr);
        expect(markdown(editor)).toBe(before);
    });
});

// ── appendTransaction escape hatch ──────────────────────────────────────────

/**
 * Appended transactions escape the tag: metas don't propagate, so the net
 * effect of a guarded gesture includes whatever normalizers append. This
 * suite pins the invariant that keeps that hole harmless: NO appendTransaction
 * plugin may change content bytes (text, atoms with content, markers). The
 * two structural normalizers get their exact, declared allowances:
 *   - trailingHrParagraphPlugin appends an EMPTY paragraph after a trailing
 *     hr (count:paragraph gain only);
 *   - mathInlineEditPlugin deletes a math node whose source was EMPTIED once
 *     the caret leaves it (the empty-identity atom entry + its count);
 *   - listSpreadNormalizePlugin is attr-only (spread) — no delta at all.
 * A future normalizer that starts touching content fails here before it can
 * slip under the guard.
 */
describe("appendTransaction normalizers", () => {
    /**
     * Content bytes conserved: text at CHARACTER level (removing a node can
     * merge its neighboring text leaves — a re-slice, not a change), atoms
     * and markers entry-exact modulo the declared allowances, counts free.
     */
    function assertConserving(trs: readonly { before: ProseNode; doc: ProseNode }[]): void {
        const charCounts = (text: string): Map<string, number> => {
            const counts = new Map<string, number>();
            for (const ch of text) {
                counts.set(ch, (counts.get(ch) ?? 0) + 1);
            }
            return counts;
        };
        for (const tr of trs) {
            expect(charCounts(tr.doc.textContent)).toEqual(charCounts(tr.before.textContent));
            const delta = diffFingerprints(fingerprintDoc(tr.before), fingerprintDoc(tr.doc));
            for (const key of [...delta.lost.keys(), ...delta.gained.keys()]) {
                const allowed =
                    key.startsWith("count:") ||
                    key.startsWith("text:") || // char conservation asserted above
                    key === "atom:math_inline:"; // the emptied-formula cleanup
                expect(
                    allowed,
                    `appendTransaction normalizer changed content: ${key}`,
                ).toBe(true);
            }
        }
    }

    async function makeNormalizerEditor(markdown: string): Promise<Editor> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(headingFoldPlugin)
            .use(listSpreadNormalizePlugin)
            .use(hrTrailingPlugin)
            .use(mathInlineEditPlugin)
            .create();
        editors.push(editor);
        return editor;
    }

    it("the trailing-hr paragraph filler should add structure only, never content", async () => {
        const editor = await makeNormalizerEditor("para\n\n---");
        const v = view(editor);
        // Any doc change triggers the normalizer while an hr is last.
        const root = v.state.tr.insertText("!", 2);
        const { transactions } = v.state.applyTransaction(root);
        const appended = transactions.slice(1);
        expect(appended.length).toBeGreaterThan(0); // the normalizer fired
        assertConserving(appended);
    });

    it("the list spread normalizer should be fingerprint-invariant", async () => {
        const editor = await makeNormalizerEditor("- a\n  - b\n- c");
        const v = view(editor);
        let subPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (subPos === -1 && node.type.name === "bullet_list" && pos > 0) {
                subPos = pos;
            }
            return subPos === -1;
        });
        expect(subPos).toBeGreaterThan(-1);
        const sub = v.state.doc.nodeAt(subPos)!;
        const root = v.state.tr.delete(subPos, subPos + sub.nodeSize);
        const { transactions } = v.state.applyTransaction(root);
        assertConserving(transactions.slice(1));
    });

    it("the empty-math cleanup should remove only the emptied atom", async () => {
        const editor = await makeNormalizerEditor("before $x$ after");
        const v = view(editor);
        let mathPos = -1;
        v.state.doc.descendants((node: ProseNode, pos: number) => {
            if (mathPos === -1 && node.type.name === "math_inline") {
                mathPos = pos;
            }
            return mathPos === -1;
        });
        expect(mathPos).toBeGreaterThan(-1);
        // Step 1: caret into the formula (the previous-selection probe).
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, mathPos + 1)));
        // Step 2: empty the source and leave — the cleanup appends a delete.
        const root = v.state.tr.delete(mathPos + 1, mathPos + 2);
        root.setSelection(TextSelection.create(root.doc, 1));
        const { transactions, state: after } = v.state.applyTransaction(root);
        const appended = transactions.slice(1);
        expect(appended.length).toBeGreaterThan(0); // the cleanup fired
        assertConserving(appended);
        let mathLeft = 0;
        after.doc.descendants((node: ProseNode) => {
            if (node.type.name === "math_inline") mathLeft++;
            return true;
        });
        expect(mathLeft).toBe(0);
    });
});
