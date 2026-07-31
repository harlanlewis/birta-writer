/**
 * In-text editor-note highlighting (webview/plugins/noteMarkers.ts), against the
 * REAL editor: which spans get a chip, that the pass is deferred rather than
 * ridden on mount, and that the gate both silences it and brings it back —
 * including the case the Notes tab's own cache once got wrong, where the marker
 * SET changes while the document does not.
 *
 * The pure scanner is covered in notesScan.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { noteMarkersKey, noteMarkersPlugin, regateNoteMarkers } from "../plugins/noteMarkers";

let editors: Editor[] = [];

function setNotesFlags(flags: { enabled?: boolean; markers?: string[] } = {}): void {
    (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
        translations: {},
        isMac: true,
        notesHighlightMarkers: flags.enabled ?? true,
        notesCustomMarkers: flags.markers ?? [],
    };
}

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
        .use(noteMarkersPlugin)
        .create();
    editors.push(editor);
    return editor;
}

const view = (editor: Editor): EditorView => editor.action((ctx) => ctx.get(editorViewCtx));

/** The decorated substrings, in document order. */
function chips(v: EditorView): string[] {
    const set = noteMarkersKey.getState(v.state)?.set;
    if (!set) { return []; }
    return set.find()
        .sort((a, b) => a.from - b.from)
        .map((d) => v.state.doc.textBetween(d.from, d.to));
}

/** Let the idle-armed first pass and its debounce run. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(50);
}

beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    setNotesFlags();
    // Before any editor is made: the plugin's idle-armed first pass falls back
    // to setTimeout in jsdom, and a real-clock timer would never be advanced.
    vi.useFakeTimers();
});

afterEach(async () => {
    vi.useRealTimers();
    for (const e of editors) { await e.destroy(); }
    editors = [];
    document.body.innerHTML = "";
    delete (window as unknown as { __i18n?: unknown }).__i18n;
});

describe("note-marker highlighting", () => {
    it("built-in text markers should each get a chip on exactly their span", async () => {
        const editor = await makeEditor(
            "The survey had [TK] respondents\n\nTODO: cite this\n\nFIXME: broken link\n",
        );
        const v = view(editor);
        await settle();

        expect(chips(v)).toEqual(["[TK]", "TODO:", "FIXME:"]);
    });

    it("a labelled bracket marker should be chipped whole", async () => {
        const editor = await makeEditor("cite [TK: the 2019 paper] here\n");
        const v = view(editor);
        await settle();

        expect(chips(v)).toEqual(["[TK: the 2019 paper]"]);
    });

    it("nothing should be decorated before the deferred first pass runs", async () => {
        const editor = await makeEditor("has [TK] here\n");
        const v = view(editor);
        // Decoration settles in AFTER first paint, never on the mount path.
        expect(chips(v)).toEqual([]);

        await settle();
        expect(chips(v)).toEqual(["[TK]"]);
    });

    it("prose that merely contains a keyword should not be chipped", async () => {
        const editor = await makeEditor("networks and pseudoTODO are fine\n");
        const v = view(editor);
        await settle();

        expect(chips(v)).toEqual([]);
    });

    it("an HTML comment should not be chipped (it already renders distinctly)", async () => {
        const editor = await makeEditor("before <!-- TODO: revisit --> after\n\n[TK]\n");
        const v = view(editor);
        await settle();

        // The comment atom is a note in the sidebar, but not a chip here.
        expect(chips(v)).toEqual(["[TK]"]);
    });

    it("a marker typed after load should be chipped once the debounce elapses", async () => {
        const editor = await makeEditor("plain line\n");
        const v = view(editor);
        await settle();
        expect(chips(v)).toEqual([]);

        v.dispatch(v.state.tr.insertText(" [TK]", v.state.doc.content.size - 1));
        await vi.advanceTimersByTimeAsync(400);

        expect(chips(v)).toEqual(["[TK]"]);
    });

    it("with the gate off nothing should be scanned or decorated", async () => {
        setNotesFlags({ enabled: false });
        const editor = await makeEditor("has [TK] here\n");
        const v = view(editor);
        await vi.advanceTimersByTimeAsync(2000);

        expect(chips(v)).toEqual([]);
    });

    it("turning the gate on live should paint without a reload; off should clear", async () => {
        setNotesFlags({ enabled: false });
        const editor = await makeEditor("has [TK] here\n");
        const v = view(editor);
        await settle();
        expect(chips(v)).toEqual([]);

        setNotesFlags({ enabled: true });
        regateNoteMarkers(v);
        await settle();
        expect(chips(v)).toEqual(["[TK]"]);

        setNotesFlags({ enabled: false });
        regateNoteMarkers(v);
        expect(chips(v)).toEqual([]);
    });

    it("a custom marker added on an UNCHANGED document should light up", async () => {
        // The scan cache is keyed on doc identity and the marker set is not in
        // that key, so the re-gate must drop it — the same invalidation bug the
        // Notes tab's cache had (notesMarkerCache.test.ts).
        const editor = await makeEditor("please DRAFT this and [TK] that\n");
        const v = view(editor);
        await settle();
        expect(chips(v)).toEqual(["[TK]"]);

        setNotesFlags({ markers: ["DRAFT"] });
        regateNoteMarkers(v);
        await settle();

        expect(chips(v)).toEqual(["DRAFT", "[TK]"]);
    });

    it("a marker inside inline code should not be chipped (it is source)", async () => {
        const editor = await makeEditor("the literal `[TK]` token, and a real [TK]\n");
        const v = view(editor);
        await settle();

        expect(chips(v)).toEqual(["[TK]"]);
        // …and it is the SECOND one — the backticked span is masked by the scanner.
        const from = noteMarkersKey.getState(v.state)!.set.find()[0]!.from;
        expect(v.state.doc.textBetween(from - 5, from)).toBe("real ");
    });
});
