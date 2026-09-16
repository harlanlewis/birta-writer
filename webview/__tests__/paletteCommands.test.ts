/**
 * What a host palette is told (webview/paletteCommands.ts): the commands the
 * page can run here with no argument, derived from the one availability
 * predicate, answered only when asked, and re-sent on a later change only to a
 * host that asked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { paletteCommandList } from "../paletteCommands";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { EDITOR_COMMANDS } from "../../shared/editorCommands";
import { APP_ONLY_CAPABILITIES, type HostCapability } from "../../shared/hostProfile";
import type { ToWebviewMessage, ToExtensionMessage } from "../../shared/messages";

type Declared = { __i18n?: { host?: { capabilities: HostCapability[]; arrangements: string[]; shortcuts: unknown[] } } };
const g = globalThis as Declared;

function declare(caps: HostCapability[], shortcuts: unknown[] = []): void {
    g.__i18n = { host: { capabilities: caps, arrangements: [], shortcuts } };
}

function deps(): MessageHandlerDeps {
    return {
        state: { getEditor: () => null, setEditor: () => {}, setLineMap: () => {}, getMarkdownSource: () => "", setMarkdownSource: () => {} },
        actions: {
            placeCaretAtLine: () => {}, scrollToDocumentLine: () => {}, getSwitchTarget: () => undefined,
            getSelectionContext: () => null, setLineOffset: () => {}, initEditor: async () => {}, retryScroll: () => {},
            getEditorView: () => null, refreshToc: () => {}, setLineNumbers: () => {}, setProjectRoot: () => {},
            applyDirectoryListing: () => {}, setCurrentProjectFile: () => {}, directoryChanged: () => {}, setFileExplorerShowHidden: () => {},
        },
        topbarTb: null,
    };
}

const palettePosts = (): Extract<ToExtensionMessage, { type: "paletteCommands" }>[] =>
    mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as ToExtensionMessage)
        .filter((m): m is Extract<ToExtensionMessage, { type: "paletteCommands" }> => m.type === "paletteCommands");

describe("paletteCommandList", () => {
    beforeEach(() => { vi.clearAllMocks(); delete g.__i18n; });

    it("on the VS Code profile should be exactly the palette-flagged commands the surface admits", () => {
        const ids = paletteCommandList().map((c) => c.id);
        const expected = EDITOR_COMMANDS.filter((m) => m.palette).map((m) => m.id);
        // Nothing app-only reaches a host without the capability, and nothing
        // that needs an argument (a table command) ever does.
        expect(ids).toEqual(expected);
        expect(ids).not.toContain("toggleFileExplorer");
        expect(ids).not.toContain("tableInsertRowAbove");
        expect(ids.length).toBeGreaterThan(20);
    });

    it("on a host declaring an app-only capability should add that capability's commands, though VS Code's palette withdrew them", () => {
        declare([...APP_ONLY_CAPABILITIES]);
        const ids = paletteCommandList().map((c) => c.id);
        const appOnly = EDITOR_COMMANDS.filter((m) =>
            "hostCapability" in m && m.hostCapability && APP_ONLY_CAPABILITIES.includes(m.hostCapability));
        expect(appOnly.length).toBeGreaterThan(1);
        for (const m of appOnly) {
            expect(m.palette, `${m.id} is app-only and so must be palette:false`).toBe(false);
            expect(ids).toContain(m.id);
        }
        // Everything gated on a capability this host lacks is still out.
        expect(ids).not.toContain("toggleToc");
    });

    it("should print a command under the host menu that binds it, and a generic heading otherwise", () => {
        declare(["toc"], [{ keys: "Mod-b", label: "Bold", command: "toggleBold", section: "Format" }]);
        const bySection = new Map(paletteCommandList().map((c) => [c.id, c.section]));
        expect(bySection.get("toggleBold")).toBe("Format");
        expect(bySection.get("toggleToc")).toBe("Editor");
    });
});

describe("requestPaletteCommands", () => {
    beforeEach(() => { vi.clearAllMocks(); delete g.__i18n; });

    it("should be answered once per request, and a target change should re-post only after a request", () => {
        const handlers = createMessageHandlers(deps());
        const container = document.createElement("div");
        const targets = { type: "syntaxSetsChanged", sets: ["gfm"] } as unknown as Extract<ToWebviewMessage, { type: "syntaxSetsChanged" }>;

        // No request yet: a change tells the host nothing.
        void handlers.syntaxSetsChanged?.(targets, container);
        expect(palettePosts()).toHaveLength(0);

        void handlers.requestPaletteCommands?.({ type: "requestPaletteCommands" }, container);
        expect(palettePosts()).toHaveLength(1);
        expect(palettePosts()[0]!.items.map((i) => i.id)).toContain("toggleBold");

        void handlers.syntaxSetsChanged?.(targets, container);
        expect(palettePosts()).toHaveLength(2);
    });
});
