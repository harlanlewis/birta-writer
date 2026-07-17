/**
 * The master proofreading gate: `toggleProofreading` flips only
 * `proofreading.enabled` — it never touches the per-domain switches (spelling,
 * grammar, style) or the sub-checks, so turning it back on restores exactly what
 * was enabled before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { toggleProofreading } from "../config";

const GATE = "proofreading.enabled";
const DOMAIN = ["styleCheck.enabled", "spellCheck.enabled", "grammarCheck.enabled"];

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

describe("toggleProofreading", () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it("with the gate on, should turn it off", () => {
        const { state } = stubConfig({ [GATE]: true });

        toggleProofreading();

        expect(state.get(GATE)).toBe(false);
    });

    it("with the gate off, should turn it on", () => {
        const { state } = stubConfig({ [GATE]: false });

        toggleProofreading();

        expect(state.get(GATE)).toBe(true);
    });

    it("should default to on when the gate is unset (so the first toggle turns it off)", () => {
        const { state } = stubConfig({});

        toggleProofreading();

        expect(state.get(GATE)).toBe(false);
    });

    it("should write only the gate, never the per-domain switches", () => {
        const { update } = stubConfig({
            [GATE]: true,
            "styleCheck.enabled": true,
            "spellCheck.enabled": false,
            "grammarCheck.enabled": true,
        });

        toggleProofreading();

        const written = update.mock.calls.map((c) => c[0]);
        expect(written).toEqual([GATE]);
        for (const key of DOMAIN) { expect(written).not.toContain(key); }
    });
});
