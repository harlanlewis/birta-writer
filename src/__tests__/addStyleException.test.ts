/**
 * "Keep this phrase" (styleAddException) must write the protect-list to the
 * user's GLOBAL settings, never the workspace, which would commit a personal
 * phrase list to the project's tracked .vscode/settings.json. Also appends
 * (preserving existing phrases) and de-dupes case-insensitively.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { addStyleException } from "../config";

const KEY = "styleCheck.exceptions";

function stubConfig(existing: string[]) {
    const update = vi.fn(() => Promise.resolve());
    const cfg = {
        get: (key: string, fallback?: unknown) => (key === KEY ? existing : fallback),
        inspect: () => undefined,
        update,
    };
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(cfg as never);
    return { update };
}

describe("addStyleException", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it("a new phrase should be appended to the list at GLOBAL scope", () => {
        (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: {} }];
        const { update } = stubConfig(["very"]);

        addStyleException("at the end of the day");

        expect(update).toHaveBeenCalledWith(
            KEY,
            ["very", "at the end of the day"],
            vscode.ConfigurationTarget.Global,
        );
        (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    it("a phrase already kept, in any case, should not be written again", () => {
        const { update } = stubConfig(["Basically"]);

        addStyleException("basically");

        expect(update).not.toHaveBeenCalled();
    });

    it("blank input should be ignored", () => {
        const { update } = stubConfig([]);

        addStyleException("   ");

        expect(update).not.toHaveBeenCalled();
    });
});
