/**
 * grammar setting migration: `spellCheck.grammar` was renamed to
 * `grammarCheck.enabled`. getProofreadConfig reads the new key, falling back to
 * the deprecated one so an existing config keeps working until it's moved.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

function stubConfig(state: Record<string, unknown>) {
    const cfg = {
        get: (key: string, fallback?: unknown) => (key in state ? state[key] : fallback),
        inspect: () => undefined,
        update: vi.fn(),
    };
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(cfg as never);
}

describe("grammar setting fallback", () => {
    afterEach(() => vi.restoreAllMocks());

    it("should prefer the new grammarCheck.enabled key", () => {
        stubConfig({ "grammarCheck.enabled": false, "spellCheck.grammar": true });
        expect(MarkdownEditorProvider.getProofreadConfig().grammarCheck).toBe(false);
    });

    it("should fall back to the deprecated spellCheck.grammar when the new key is unset", () => {
        stubConfig({ "spellCheck.grammar": false });
        expect(MarkdownEditorProvider.getProofreadConfig().grammarCheck).toBe(false);
    });

    it("should default to on when neither key is set", () => {
        stubConfig({});
        expect(MarkdownEditorProvider.getProofreadConfig().grammarCheck).toBe(true);
    });
});
