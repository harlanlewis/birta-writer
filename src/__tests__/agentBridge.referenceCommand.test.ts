/**
 * The clipboard commands: what lands on the clipboard, what has to be true
 * about the file first, and what the user is told.
 *
 * The two named commands mean exactly what they say. `auto`, which the
 * selection palette's button uses, is the only one that reads the selection to
 * decide, and it is the one worth pinning: a pointer alone is what a tool
 * working IN the project wants, and a tool that cannot open the file needs the
 * lines too.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { registerReferenceCommands } from "../agentBridge/referenceCommand";
import type { ActiveEditorContext } from "../agentBridge/api";
import type { EditorSelectionContext } from "../../shared/agentContext";

const URI = (vscode as unknown as { Uri: { file(p: string): unknown } }).Uri;
const clipboard = (vscode as unknown as {
    env: { clipboard: { writeText: { mock: { calls: string[][] } } } };
}).env.clipboard;
const window = vscode.window as unknown as {
    showInformationMessage: { mock: { calls: unknown[][] } };
    showWarningMessage: { mock: { calls: unknown[][] } };
};
const workspace = vscode.workspace as unknown as {
    openTextDocument: { mockResolvedValue(v: unknown): void };
};
const register = (vscode.commands as unknown as {
    registerCommand: { mock: { calls: unknown[][] } };
}).registerCommand;

const DOC = "# Title\n\nalpha\nbeta\ngamma\n";

const caret = (line: number): EditorSelectionContext => ({
    selections: [{ anchor: { line, column: 0 }, active: { line, column: 0 }, text: "" }],
    primary: 0,
    isEmpty: true,
});

const span = (from: number, to: number, text: string): EditorSelectionContext => ({
    selections: [{ anchor: { line: from, column: 0 }, active: { line: to, column: 5 }, text }],
    primary: 0,
    isEmpty: false,
});

/**
 * Register the commands over a fixed active context, and return a way to run
 * one BY ITS COMMAND ID.
 *
 * Through the registration rather than through a returned function, because
 * the ids are half of what is under test: `birta._copyForAgent` is what
 * `MarkdownEditorProvider` executes for the palette button, and a function
 * handed straight to the test would pin the behaviour while leaving the name
 * it is reached by unchecked.
 */
function setup(
    context: EditorSelectionContext | null,
    doc: { isDirty: boolean; save: () => Promise<boolean>; getText: () => string },
): (id: string) => Promise<void> {
    workspace.openTextDocument.mockResolvedValue(doc);
    const active: ActiveEditorContext | null = context
        ? { uri: URI.file("/project/note.md") as ActiveEditorContext["uri"], context }
        : null;
    const subscriptions: unknown[] = [];
    registerReferenceCommands(
        { subscriptions } as unknown as vscode.ExtensionContext,
        async () => active,
    );
    const registered = new Map<string, () => Promise<void>>(
        register.mock.calls.map(([id, handler]) => [
            id as string,
            handler as () => Promise<void>,
        ]),
    );
    return async (id: string) => {
        const handler = registered.get(id);
        expect(handler, `no command registered as ${id}`).toBeTruthy();
        await handler!();
    };
}

const AUTO = "birta._copyForAgent";
const REFERENCE = "birta.copyAgentReference";
const CONTEXT = "birta.copyAgentContext";

const cleanDoc = () => ({
    isDirty: false,
    save: vi.fn(async () => true),
    getText: () => DOC,
});

describe("the agent clipboard commands", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a caret should copy the reference alone, whichever mode asked", async () => {
        // Arrange
        const copy = setup(caret(3), cleanDoc());

        // Act
        await copy(AUTO);

        // Assert — nothing to quote, so `auto` is the pointer.
        expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toBe("project/note.md#L3");
    });

    it("auto should quote the selected lines when there IS a selection", async () => {
        // Arrange
        const copy = setup(span(3, 4, "alpha\nbeta"), cleanDoc());

        // Act
        await copy(AUTO);

        // Assert — the pointer AND the lines, so the payload is useful in a
        // tool that can open the file and in one that cannot.
        const payload = clipboard.writeText.mock.calls.at(-1)?.[0] ?? "";
        expect(payload.startsWith("project/note.md#L3-L4")).toBe(true);
        expect(payload).toContain("```markdown\nalpha\nbeta");
    });

    it("the named reference command should stay a pointer even with a selection", async () => {
        // Arrange — the palette commands must not change meaning under the
        // user; only the button's `auto` reads the selection.
        const copy = setup(span(3, 4, "alpha\nbeta"), cleanDoc());

        // Act
        await copy(REFERENCE);

        // Assert
        expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toBe("project/note.md#L3-L4");
    });

    it("the named context command should quote even from a bare caret's document", async () => {
        // Arrange
        const copy = setup(caret(3), cleanDoc());

        // Act
        await copy(CONTEXT);

        // Assert — a caret has nothing to quote, so it degrades to the
        // pointer; what matters is that the MODE did not consult the
        // selection to decide, the content did.
        expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toBe("project/note.md#L3");
    });

    it("a dirty document should be saved before anything is copied", async () => {
        // Arrange — the reference names lines in a FILE, so the file has to
        // hold them. A pointer into bytes that are not on disk is worse than
        // no pointer: it looks like it worked.
        const save = vi.fn(async () => true);
        const copy = setup(caret(3), { isDirty: true, save, getText: () => DOC });

        // Act
        await copy(AUTO);

        // Assert
        expect(save).toHaveBeenCalledTimes(1);
        expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toBe("project/note.md#L3");
    });

    it("a save that fails should copy NOTHING and say so", async () => {
        // Arrange
        const copy = setup(caret(3), { isDirty: true, save: vi.fn(async () => false), getText: () => DOC });

        // Act
        await copy(AUTO);

        // Assert — the whole point of the save. Copying anyway would hand an
        // agent a reference the file cannot honour.
        expect(clipboard.writeText).not.toHaveBeenCalled();
        expect(window.showWarningMessage).toHaveBeenCalledTimes(1);
    });

    it("a clean document should not be saved", async () => {
        // Arrange — the copy is a read; it must not touch the file's mtime or
        // fire a save participant for a document that had nothing to write.
        const doc = cleanDoc();
        const copy = setup(caret(3), doc);

        // Act
        await copy(AUTO);

        // Assert
        expect(doc.save).not.toHaveBeenCalled();
    });

    it("a successful copy should be reported in a notification naming the reference", async () => {
        // Arrange — the question this answers is "did it copy", asked in the
        // half-second before pasting somewhere else, and it names the
        // reference because that is the part worth checking.
        const copy = setup(caret(3), cleanDoc());

        // Act
        await copy(AUTO);

        // Assert
        expect(window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(String(window.showInformationMessage.mock.calls[0][0])).toContain(
            "project/note.md#L3",
        );
    });

    it("with no active editor it should copy nothing and not claim it did", async () => {
        // Arrange
        const copy = setup(null, cleanDoc());

        // Act
        await copy(AUTO);

        // Assert
        expect(clipboard.writeText).not.toHaveBeenCalled();
        expect(window.showInformationMessage).not.toHaveBeenCalled();
    });
});
