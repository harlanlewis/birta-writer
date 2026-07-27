/**
 * Target resolution for the Birta→raw switch keybinding (Cmd+Shift+M).
 *
 * The regression: with a split showing TWO Birta editors, scanning
 * tabGroups.all for "the first group whose active tab is a custom editor"
 * always found the LEFT pane, so the keybinding switched the wrong editor
 * while the toolbar button (which originates inside the focused webview)
 * behaved. Resolution must read the ACTIVE tab group only — the keybinding's
 * when-clause guarantees the focused tab is a Birta editor when it fires.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import { activeCustomEditorUri } from "../extension";

type MutableTabGroups = {
    activeTabGroup: { activeTab?: { input?: unknown } };
    all: unknown[];
};

const tabGroups = (): MutableTabGroups =>
    vscode.window.tabGroups as unknown as MutableTabGroups;

const customTab = (path: string) => ({
    input: new vscode.TabInputCustom(vscode.Uri.file(path), "birta.editor"),
});

describe("activeCustomEditorUri", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tabGroups().activeTabGroup = { activeTab: undefined };
        tabGroups().all = [];
    });

    it("a split with two Birta panes should resolve the FOCUSED pane, not the first", () => {
        const left = { activeTab: customTab("/notes/left.md") };
        const right = { activeTab: customTab("/notes/right.md") };
        tabGroups().all = [left, right];
        tabGroups().activeTabGroup = right;
        expect((activeCustomEditorUri() as vscode.Uri).fsPath).toBe("/notes/right.md");
    });

    it("a focused non-custom tab should resolve nothing, even with a Birta pane elsewhere", () => {
        const left = { activeTab: customTab("/notes/left.md") };
        const right = { activeTab: { input: {} } }; // a text tab
        tabGroups().all = [left, right];
        tabGroups().activeTabGroup = right;
        expect(activeCustomEditorUri()).toBeUndefined();
    });

    it("no active tab at all should resolve nothing", () => {
        expect(activeCustomEditorUri()).toBeUndefined();
    });
});
