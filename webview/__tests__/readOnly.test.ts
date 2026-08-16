/**
 * Read-only mode (MAR-53).
 *
 * Two things are worth pinning here rather than in the e2e sweep, and one
 * thing deliberately is not.
 *
 * The classifications are: they are the enumeration the mode's affordances
 * rest on, and an enumeration that reached nothing passes, so each one asserts
 * its own SIZE against the list it partitions rather than trusting the
 * `Record<Id, …>` type to have been filled in truthfully. The type makes a
 * MISSING key a compile error; only a count catches the other direction, where
 * the shared list shrank and left an entry classifying a command that no
 * longer exists.
 *
 * The gates are: `runEditorCommand` and `notifyFrontmatterUpdate` are the two
 * refusals that are pure logic, so they can be driven directly.
 *
 * What is NOT here: whether the lock actually holds. jsdom has no layout
 * engine and, more to the point, dispatches none of the browser input pipeline
 * that `editable` gates, so a test asserting "typing does nothing" would pass
 * against an editor with no lock at all. That claim is driven as real gestures
 * in `e2e/readOnly`, and the suite carries its own control proving the same
 * gestures DO edit when the mode is off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EDITOR_COMMANDS } from "../../shared/editorCommands";
import {
    COMMAND_EFFECTS,
    commandMutates,
    markEditableIsland,
    setReadOnly,
    subscribeReadOnly,
} from "../readOnly";
import { editorCommands, runEditorCommand } from "../editorCommands";
import { notifyFrontmatterUpdate } from "../messaging";
import { mockVscodeApi } from "./setup";
import { ITEM_MUTATES, TOOLBAR_ITEM_IDS } from "../components/toolbar/registry";

describe("read-only command classification", () => {
    it("every editor command should be classified exactly once", () => {
        const classified = Object.keys(COMMAND_EFFECTS).sort();
        const contributed = EDITOR_COMMANDS.map((c) => c.id).sort();
        expect(classified).toEqual(contributed);
        // The size, stated outright: a partition over an empty list is
        // vacuously total, and this is the assertion that would catch it.
        expect(classified.length).toBe(EDITOR_COMMANDS.length);
        expect(classified.length).toBeGreaterThan(90);
    });

    it("the partition should have both halves populated", () => {
        const values = Object.values(COMMAND_EFFECTS);
        const mutating = values.filter((v) => v === "mutates").length;
        const reading = values.filter((v) => v === "reads").length;
        expect(mutating + reading).toBe(values.length);
        expect(mutating).toBeGreaterThan(40);
        expect(reading).toBeGreaterThan(20);
    });

    it("a command that writes text should be classified as mutating", () => {
        for (const id of ["toggleBold", "insertTable", "deleteBlock", "tableDeleteRow", "pasteAsPlainText"]) {
            expect(commandMutates(id)).toBe(true);
        }
    });

    it("a command that only reads or navigates should not be classified as mutating", () => {
        for (const id of ["openFind", "foldAll", "copyAsMarkdown", "toggleToc", "editRawMarkdown"]) {
            expect(commandMutates(id)).toBe(false);
        }
    });

    it("an unknown command id should not be treated as mutating", () => {
        expect(commandMutates("noSuchCommand")).toBe(false);
    });

    /**
     * The e2e suite cannot import TypeScript, so it carries its own copy of the
     * mutating list. This is the join that keeps the two from drifting: add a
     * mutating command and forget the e2e list, and this fails rather than the
     * sweep quietly testing 57 of 58.
     */
    it("the e2e mutating-command list should match the classification", () => {
        // `__dirname`, not `import.meta.url`: Vitest's jsdom environment does
        // not give this module a file:// URL, so the URL form throws before it
        // ever reads anything.
        const source = readFileSync(
            join(__dirname, "..", "..", "e2e", "readOnly", "checks.mjs"), "utf8");
        const block = source.split("const MUTATING_COMMANDS = [")[1]!.split("];")[0]!;
        const inE2e = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
        const classified = Object.entries(COMMAND_EFFECTS)
            .filter(([, effect]) => effect === "mutates")
            .map(([id]) => id)
            .sort();
        expect(inE2e).toEqual(classified);
    });
});

describe("read-only toolbar-item classification", () => {
    it("every toolbar item should be classified exactly once", () => {
        expect(Object.keys(ITEM_MUTATES).sort()).toEqual([...TOOLBAR_ITEM_IDS].sort());
        expect(Object.keys(ITEM_MUTATES).length).toBe(TOOLBAR_ITEM_IDS.length);
    });

    it("the mode toggle and the view controls should not be classified as mutating", () => {
        expect(ITEM_MUTATES.readOnly).toBe(false);
        expect(ITEM_MUTATES.viewSource).toBe(false);
        expect(ITEM_MUTATES.find).toBe(false);
        expect(ITEM_MUTATES.settings).toBe(false);
    });

    it("the formatting and insert items should be classified as mutating", () => {
        expect(ITEM_MUTATES.bold).toBe(true);
        expect(ITEM_MUTATES.table).toBe(true);
        expect(ITEM_MUTATES.image).toBe(true);
    });
});

describe("the mode itself", () => {
    beforeEach(() => {
        setReadOnly(false);
    });

    it("setting the mode should announce it to subscribers exactly once", () => {
        const seen: boolean[] = [];
        const off = subscribeReadOnly((v) => seen.push(v));
        setReadOnly(true);
        setReadOnly(true); // idempotent: no second announcement
        setReadOnly(false);
        off();
        setReadOnly(true);
        expect(seen).toEqual([true, false]);
    });

    it("setting the mode should mirror onto the body class", () => {
        setReadOnly(true);
        expect(document.body.classList.contains("read-only")).toBe(true);
        setReadOnly(false);
        expect(document.body.classList.contains("read-only")).toBe(false);
    });

    it("an element marked an editable island should follow the mode in both directions", () => {
        const el = document.createElement("span");
        document.body.appendChild(el);
        markEditableIsland(el);
        expect(el.getAttribute("contenteditable")).not.toBe("false");
        setReadOnly(true);
        expect(el.getAttribute("contenteditable")).toBe("false");
        setReadOnly(false);
        expect(el.getAttribute("contenteditable")).not.toBe("false");
        el.remove();
    });

    it("an island created WHILE read-only should be born non-editable", () => {
        setReadOnly(true);
        const el = document.createElement("span");
        document.body.appendChild(el);
        markEditableIsland(el);
        expect(el.getAttribute("contenteditable")).toBe("false");
        el.remove();
    });
});

describe("the command gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setReadOnly(false);
    });

    it("read-only should refuse a mutating command and still run a reading one", () => {
        const bold = vi.spyOn(editorCommands, "toggleBold").mockImplementation(() => {});
        const find = vi.spyOn(editorCommands, "openFind").mockImplementation(() => {});
        const getEditor = (): null => null;

        setReadOnly(true);
        runEditorCommand("toggleBold", getEditor);
        runEditorCommand("openFind", getEditor);
        expect(bold).not.toHaveBeenCalled();
        expect(find).toHaveBeenCalledTimes(1);

        // The control: the SAME call reaches the same registry entry with the
        // mode off, so the assertion above is about the gate rather than about
        // a spy that was never wired.
        setReadOnly(false);
        runEditorCommand("toggleBold", getEditor);
        expect(bold).toHaveBeenCalledTimes(1);

        bold.mockRestore();
        find.mockRestore();
    });
});

describe("the frontmatter write gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setReadOnly(false);
    });

    /**
     * The frontmatter panel is the ONE document write that never becomes a
     * ProseMirror transaction, so the transaction filter cannot see it. This
     * is the check that the separate refusal is really there.
     */
    it("read-only should not post a frontmatter write, and should post one when editable", () => {
        setReadOnly(true);
        notifyFrontmatterUpdate("---\ntitle: locked\n---\n");
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();

        // The control: the same call posts when the mode is off, so the
        // assertion above is about the gate and not about a silent sender.
        setReadOnly(false);
        notifyFrontmatterUpdate("---\ntitle: editable\n---\n");
        expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(1);
        expect(mockVscodeApi.postMessage.mock.calls[0]![0]).toMatchObject({
            type: "frontmatterUpdate",
        });
    });
});
