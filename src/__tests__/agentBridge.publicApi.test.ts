/**
 * The public API surface (src/agentBridge/publicApi.ts) other extensions consume
 * via `await ext.activate()`. It maps the internal context to VS Code-flavoured
 * (0-indexed) coordinates and passes a missing editor through as null.
 */
import { describe, it, expect, vi } from "vitest";
import { createBirtaApi } from "../agentBridge/publicApi";
import type { ActiveEditorContext } from "../agentBridge/api";
import type { EditorSelectionContext } from "../../shared/agentContext";

const fakeUri = (fsPath: string) =>
    ({ fsPath, toString: () => `file://${fsPath}` }) as unknown as ActiveEditorContext["uri"];

const context = (sel: EditorSelectionContext["selections"][number], isEmpty: boolean): EditorSelectionContext => ({
    selections: [sel],
    primary: 0,
    isEmpty,
});

describe("createBirtaApi().getActiveEditorContext", () => {
    it("should map a resolved context to 0-indexed VS Code coordinates", async () => {
        const active: ActiveEditorContext = {
            uri: fakeUri("/p/note.md"),
            context: context(
                { anchor: { line: 3, column: 2 }, active: { line: 5, column: 4 }, text: "sel" },
                false,
            ),
        };
        const api = createBirtaApi(() => Promise.resolve(active));

        expect(await api.getActiveEditorContext()).toEqual({
            uri: "file:///p/note.md",
            fsPath: "/p/note.md",
            selection: { start: { line: 2, character: 2 }, end: { line: 4, character: 4 } },
            selectedText: "sel",
            isEmpty: false,
        });
    });

    it("should return null when no Birta editor is active", async () => {
        const getActive = vi.fn(() => Promise.resolve(null));
        const api = createBirtaApi(getActive);
        expect(await api.getActiveEditorContext()).toBeNull();
        expect(getActive).toHaveBeenCalledOnce();
    });

    it("should report apiVersion 1", () => {
        expect(createBirtaApi(() => Promise.resolve(null)).apiVersion).toBe(1);
    });
});
