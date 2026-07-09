/**
 * The "go clean" all-checks toggle: flips spelling, grammar, and style together
 * — all off when any is on, all back on when every one is off — and never
 * touches the per-check sub-settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { MarkdownEditorProvider } from "../MarkdownEditorProvider";

const MASTERS = ["styleCheck.enabled", "spellCheck.enabled", "spellCheck.grammar"];
const SUB = "styleCheck.passive";

function stubConfig(initial: Record<string, boolean>) {
    const state = new Map<string, boolean>(Object.entries(initial));
    const update = vi.fn((key: string, value: boolean) => {
        state.set(key, value);
        return Promise.resolve();
    });
    const cfg = {
        get: (key: string, fallback?: boolean) => (state.has(key) ? state.get(key) : fallback),
        inspect: () => undefined,
        update,
    };
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(cfg as never);
    return { state, update };
}

describe("toggleAllChecks", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it("with everything on, should turn all three masters off", () => {
        const { state, update } = stubConfig({
            "styleCheck.enabled": true, "spellCheck.enabled": true, "spellCheck.grammar": true,
        });

        MarkdownEditorProvider.toggleAllChecks();

        expect(update).toHaveBeenCalledTimes(3);
        for (const key of MASTERS) { expect(state.get(key), key).toBe(false); }
    });

    it("with everything off, should turn all three masters on", () => {
        const { state } = stubConfig({
            "styleCheck.enabled": false, "spellCheck.enabled": false, "spellCheck.grammar": false,
        });

        MarkdownEditorProvider.toggleAllChecks();

        for (const key of MASTERS) { expect(state.get(key), key).toBe(true); }
    });

    it("with only one master on, should treat that as 'any on' and turn all off", () => {
        const { state } = stubConfig({
            "styleCheck.enabled": false, "spellCheck.enabled": true, "spellCheck.grammar": false,
        });

        MarkdownEditorProvider.toggleAllChecks();

        for (const key of MASTERS) { expect(state.get(key), key).toBe(false); }
    });

    it("should not write any per-check sub-setting", () => {
        const { update } = stubConfig({
            "styleCheck.enabled": true, "spellCheck.enabled": true, "spellCheck.grammar": true,
            [SUB]: true,
        });

        MarkdownEditorProvider.toggleAllChecks();

        const written = update.mock.calls.map((c) => c[0]);
        expect(written).not.toContain(SUB);
        expect(new Set(written)).toEqual(new Set(MASTERS));
    });
});
