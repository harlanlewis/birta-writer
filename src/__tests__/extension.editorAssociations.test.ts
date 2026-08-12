/**
 * syncEditorAssociation owns exactly the associations it wrote — the
 * "default" entries for *.md/*.markdown — and nothing else. Found via the
 * MAR-228 code-server smoke test: a profile with a user-authored
 * `"*.md": "birta.editor"` association had it silently deleted on every
 * activation, because preview mode removed ANY *.md entry on the assumption
 * it was its own leftover. The write must also be skipped when nothing
 * changed, so activation does not churn settings.json.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { syncEditorAssociation } from "../extension";

function mockWorkbenchConfig(associations: Record<string, string> | undefined) {
    const update = vi.fn();
    const cfg = {
        get: vi.fn((key: string) => (key === "editorAssociations" ? associations : undefined)),
        inspect: vi.fn(() => undefined),
        update,
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
    return { update };
}

describe("syncEditorAssociation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("preview mode with a user-authored *.md association should leave it untouched", () => {
        const { update } = mockWorkbenchConfig({ "*.md": "birta.editor" });

        syncEditorAssociation("preview");

        expect(update).not.toHaveBeenCalled();
    });

    it("preview mode should remove only the 'default' entries it wrote", () => {
        const { update } = mockWorkbenchConfig({
            "*.md": "default",
            "*.markdown": "default",
            "*.ipynb": "jupyter-notebook",
        });

        syncEditorAssociation("preview");

        expect(update).toHaveBeenCalledWith(
            "editorAssociations",
            { "*.ipynb": "jupyter-notebook" },
            vscode.ConfigurationTarget.Global,
        );
    });

    it("preview mode with a mixed map should drop 'default' globs and keep the user's", () => {
        const { update } = mockWorkbenchConfig({
            "*.md": "birta.editor",
            "*.markdown": "default",
        });

        syncEditorAssociation("preview");

        expect(update).toHaveBeenCalledWith(
            "editorAssociations",
            { "*.md": "birta.editor" },
            vscode.ConfigurationTarget.Global,
        );
    });

    it("markdown mode should write 'default' for both markdown globs", () => {
        const { update } = mockWorkbenchConfig(undefined);

        syncEditorAssociation("markdown");

        expect(update).toHaveBeenCalledWith(
            "editorAssociations",
            { "*.md": "default", "*.markdown": "default" },
            vscode.ConfigurationTarget.Global,
        );
    });

    it("markdown mode with the entries already in place should not write at all", () => {
        const { update } = mockWorkbenchConfig({
            "*.md": "default",
            "*.markdown": "default",
        });

        syncEditorAssociation("markdown");

        expect(update).not.toHaveBeenCalled();
    });

    it("preview mode with no markdown associations should not write at all", () => {
        const { update } = mockWorkbenchConfig({ "*.ipynb": "jupyter-notebook" });

        syncEditorAssociation("preview");

        expect(update).not.toHaveBeenCalled();
    });
});
