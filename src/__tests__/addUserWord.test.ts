/**
 * "Add to dictionary" (spellAddWord) must write the personal word list to the
 * user's GLOBAL settings — never the workspace, which would land the dictionary
 * in the project's tracked .vscode/settings.json and commit it to git. Also
 * appends (preserving existing words) and de-dupes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const KEY = "spellCheck.userWords";

function stubConfig(existingWords: string[]) {
    const update = vi.fn(() => Promise.resolve());
    const cfg = {
        get: (key: string, fallback?: unknown) => (key === KEY ? existingWords : fallback),
        inspect: () => undefined,
        update,
    };
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(cfg as never);
    return { update };
}

describe("addUserWord", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it("should write the new word to GLOBAL settings, even with a workspace open", () => {
        // Arrange — a workspace is open (the case that used to pick Workspace)
        (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
            { uri: {} },
        ];
        const { update } = stubConfig([]);

        // Act
        MarkdownEditorProvider.addUserWord("Birta");

        // Assert — appended to userWords at Global scope (never Workspace, so it
        // can't land in the repo's .vscode/settings.json)
        expect(update).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalledWith(
            KEY,
            ["Birta"],
            vscode.ConfigurationTarget.Global,
        );
        (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("should append to the existing list rather than replace it", () => {
        const { update } = stubConfig(["Foo"]);

        MarkdownEditorProvider.addUserWord("Bar");

        expect(update).toHaveBeenCalledWith(
            KEY,
            ["Foo", "Bar"],
            vscode.ConfigurationTarget.Global,
        );
    });

    it("should no-op for a word already in the dictionary", () => {
        const { update } = stubConfig(["Birta"]);

        MarkdownEditorProvider.addUserWord("Birta");

        expect(update).not.toHaveBeenCalled();
    });

    it("should ignore blank input", () => {
        const { update } = stubConfig([]);

        MarkdownEditorProvider.addUserWord("   ");

        expect(update).not.toHaveBeenCalled();
    });
});
