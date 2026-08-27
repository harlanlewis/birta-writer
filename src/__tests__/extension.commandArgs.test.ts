/**
 * What an editor command's argument survives on the way to the webview.
 *
 * Every command in `EDITOR_COMMANDS` is registered through one shared closure,
 * and its argument shaping used to read the argument only as an OBJECT, because
 * the two callers it was written for are a webview context menu and a native
 * context menu, both of which pass `data-vscode-context`. A keybinding is the
 * third caller and it passes whatever `"args"` says: `"args": "passive"` arrives
 * as the bare string.
 *
 * So a command whose whole payload is one word did nothing in VS Code while
 * working in the Mac app, whose bridge hands `args` straight through, and it was
 * announced in the CHANGELOG with a `keybindings.json` recipe. Nothing could
 * have caught it: the command existed, its id was contributed, and the guard
 * that checks CHANGELOG citations only asks whether an id exists. The shaping
 * lived inside `activate`, where a test could reach it only by standing up the
 * whole extension host, which is why it is a named function now.
 */
import { describe, it, expect } from "vitest";

import { editorCommandArgs } from "../extension";

describe("editorCommandArgs", () => {
    it("a string should be forwarded as itself", () => {
        // The keybinding case, and the whole reason this file exists.
        expect(editorCommandArgs("passive")).toBe("passive");
    });

    it("the other primitives a keybinding can carry should be forwarded too", () => {
        expect(editorCommandArgs(3)).toBe(3);
        expect(editorCommandArgs(true)).toBe(true);
        // Zero and the empty string are the two that a truthiness test would
        // drop, and a command taking a count or a name has both as real values.
        expect(editorCommandArgs(0)).toBe(0);
        expect(editorCommandArgs("")).toBe("");
    });

    it("nothing should stay undefined rather than becoming an empty object", () => {
        // A palette invocation. An empty object would read to the webview as a
        // payload that was supplied and happened to be empty.
        expect(editorCommandArgs()).toBeUndefined();
        expect(editorCommandArgs(undefined)).toBeUndefined();
    });

    it("a context object should yield only its click targets", () => {
        expect(editorCommandArgs({
            documentUri: "file:///note.md",
            blockTarget: { blockPos: 12 },
        })).toEqual({ blockPos: 12 });
    });

    it("both click targets should merge into one payload", () => {
        expect(editorCommandArgs({
            tableTarget: { cellPos: 4 },
            blockTarget: { blockPos: 12 },
        })).toEqual({ cellPos: 4, blockPos: 12 });
    });

    it("a routing hint alone should not become a payload", () => {
        // `documentUri` is read separately, to pick the webview. If it reached
        // the webview as `args` a command reading its payload would see a URI
        // where it expected its own argument.
        expect(editorCommandArgs({ documentUri: "file:///note.md" })).toBeUndefined();
    });

    it("a context object should never be forwarded whole", () => {
        // The invariant behind the two cases above, stated so it holds for a
        // key nobody has added yet.
        const out = editorCommandArgs({
            documentUri: "file:///note.md",
            somethingNew: "x",
            blockTarget: { blockPos: 1 },
        });
        expect(out).not.toHaveProperty("documentUri");
        expect(out).not.toHaveProperty("somethingNew");
    });

    it("a non-object target should not smuggle its characters into the payload", () => {
        // Spreading a string yields its characters under numeric keys, so a
        // malformed context blob would produce a payload nobody wrote.
        expect(editorCommandArgs({ blockTarget: "ab" })).toEqual({});
    });
});
