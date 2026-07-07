/**
 * messageHandlers.ts tests: table-wrap CSS application, plus the editorCommand
 * dispatch path (MAR-9).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { applyTableWrap, createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { setEditorCommandHost } from "../editorCommands";
import type { ToWebviewMessage, ToolbarConfig } from "../../shared/messages";
import { FONT_PRESET_STACKS } from "../../shared/fontPresets";

/** Minimal deps: the editorCommand handler only reaches state.getEditor. */
function stubDeps(): MessageHandlerDeps {
    return {
        state: {
            getEditor: () => null,
            setEditor: () => {},
            getLineMap: () => [],
            setLineMap: () => {},
            getMarkdownSource: () => "",
            setMarkdownSource: () => {},
        },
        actions: {
            scrollToSourceLine: () => {},
            getFirstVisibleSourceLine: () => 1,
            initEditor: async () => {},
            retryScroll: () => {},
            getEditorView: () => null,
            refreshToc: () => {},
        },
        topbarTb: null,
        themeOverrides: new Set<string>(),
    };
}

describe("applyTableWrap", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear the CSS variable
        const root = document.documentElement;
        root.style.removeProperty("--tbl-ow");
    });

    it("aggressive mode should set overflow-wrap: anywhere", () => {
        applyTableWrap("aggressive");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("anywhere");
    });

    it("normal mode should set overflow-wrap: break-word", () => {
        applyTableWrap("normal");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("break-word");
    });

    it("none mode should set overflow-wrap: normal", () => {
        applyTableWrap("none");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("normal");
    });

    it("switching modes should override the previous setting", () => {
        applyTableWrap("aggressive");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("anywhere");

        applyTableWrap("normal");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("break-word");

        applyTableWrap("none");
        expect(document.documentElement.style.getPropertyValue("--tbl-ow").trim()).toBe("normal");
    });
});

describe("editorCommand handler", () => {
    beforeEach(() => vi.clearAllMocks());

    it("a known command should dispatch into the editor-command registry", () => {
        // Arrange — a host-delegating command lets us observe the dispatch
        // without a live Milkdown editor.
        const toggleToc = vi.fn();
        setEditorCommandHost({ toggleToc });
        const handlers = createMessageHandlers(stubDeps());
        const container = document.createElement("div");

        // Act
        handlers.editorCommand?.(
            { type: "editorCommand", command: "toggleToc" } as Extract<ToWebviewMessage, { type: "editorCommand" }>,
            container,
        );

        // Assert
        expect(toggleToc).toHaveBeenCalledTimes(1);
    });

    it("an unknown command id should be a no-op", () => {
        const handlers = createMessageHandlers(stubDeps());
        const container = document.createElement("div");
        expect(() =>
            handlers.editorCommand?.(
                // Deliberately invalid id: the registry ignores it.
                { type: "editorCommand", command: "nope" } as unknown as Extract<ToWebviewMessage, { type: "editorCommand" }>,
                container,
            ),
        ).not.toThrow();
    });
});

describe("requestSwitchToTextEditor handler", () => {
    // The ONLY switch path for the contributed (user-rebindable)
    // Cmd/Ctrl+Shift+M keybinding: the extension command posts this message,
    // the webview answers with switchToTextEditor carrying the first visible
    // source line so the text editor restores the viewport.
    beforeEach(() => vi.clearAllMocks());

    const container = document.createElement("div");

    it("with a live editor view it should reply with the first visible source line", () => {
        const deps = stubDeps();
        deps.actions.getEditorView = () => ({} as never);
        deps.actions.getFirstVisibleSourceLine = () => 42;
        const handlers = createMessageHandlers(deps);

        handlers.requestSwitchToTextEditor?.(
            { type: "requestSwitchToTextEditor" },
            container,
        );

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "switchToTextEditor",
            line: 42,
        });
    });

    it("without an editor view it should reply without a line", () => {
        const handlers = createMessageHandlers(stubDeps());

        handlers.requestSwitchToTextEditor?.(
            { type: "requestSwitchToTextEditor" },
            container,
        );

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "switchToTextEditor",
        });
    });
});

describe("setFontFamily handler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.documentElement.style.removeProperty("--content-font-family");
    });

    const container = document.createElement("div");

    it("a resolved font family should set the --content-font-family variable", () => {
        // Arrange
        const setFontPreset = vi.fn();
        const deps = { ...stubDeps(), topbarTb: { onSelectionChange() {}, setDebugMode() {}, applyConfig() {}, setFontPreset, setFontSize() {} } };
        const handlers = createMessageHandlers(deps);

        // Act
        handlers.setFontFamily?.(
            { type: "setFontFamily", fontFamily: "Georgia, serif", preset: "serif", stacks: FONT_PRESET_STACKS },
            container,
        );

        // Assert
        expect(document.documentElement.style.getPropertyValue("--content-font-family").trim()).toBe("Georgia, serif");
        expect(setFontPreset).toHaveBeenCalledWith("serif", FONT_PRESET_STACKS);
    });

    it("a null font family should remove the --content-font-family variable", () => {
        // Arrange: set it first, then clear it
        document.documentElement.style.setProperty("--content-font-family", "Georgia, serif");
        const handlers = createMessageHandlers(stubDeps());

        // Act
        handlers.setFontFamily?.(
            { type: "setFontFamily", fontFamily: null, preset: "editor", stacks: FONT_PRESET_STACKS },
            container,
        );

        // Assert
        expect(document.documentElement.style.getPropertyValue("--content-font-family")).toBe("");
    });
});

describe("setFontSize handler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.documentElement.style.removeProperty("--content-font-scale");
    });

    const container = document.createElement("div");

    it("a size message should set --content-font-scale as a ratio and update the toolbar", () => {
        // Arrange
        const setFontSize = vi.fn();
        const deps = { ...stubDeps(), topbarTb: { onSelectionChange() {}, setDebugMode() {}, applyConfig() {}, setFontPreset() {}, setFontSize } };
        const handlers = createMessageHandlers(deps);

        // Act
        handlers.setFontSize?.({ type: "setFontSize", size: 125 }, container);

        // Assert
        expect(document.documentElement.style.getPropertyValue("--content-font-scale").trim()).toBe("1.25");
        expect(setFontSize).toHaveBeenCalledWith(125);
    });

    it("an out-of-range size should be clamped before it is applied", () => {
        const setFontSize = vi.fn();
        const deps = { ...stubDeps(), topbarTb: { onSelectionChange() {}, setDebugMode() {}, applyConfig() {}, setFontPreset() {}, setFontSize } };
        const handlers = createMessageHandlers(deps);

        handlers.setFontSize?.({ type: "setFontSize", size: 9999 }, container);

        expect(document.documentElement.style.getPropertyValue("--content-font-scale").trim()).toBe("2");
        expect(setFontSize).toHaveBeenCalledWith(200);
    });

    it("without a toolbar controller it should still set the CSS variable", () => {
        const handlers = createMessageHandlers(stubDeps());

        handlers.setFontSize?.({ type: "setFontSize", size: 90 }, container);

        expect(document.documentElement.style.getPropertyValue("--content-font-scale").trim()).toBe("0.9");
    });
});

describe("toolbarConfig handler", () => {
    beforeEach(() => vi.clearAllMocks());

    it("a toolbarConfig message should forward the config to the toolbar controller", () => {
        // Arrange
        const applyConfig = vi.fn();
        const deps = { ...stubDeps(), topbarTb: { onSelectionChange() {}, setDebugMode() {}, applyConfig, setFontPreset() {}, setFontSize() {} } };
        const handlers = createMessageHandlers(deps);

        // Act
        const config: ToolbarConfig = { placements: { bold: "right" }, order: [] };
        handlers.toolbarConfig?.(
            { type: "toolbarConfig", config },
            document.createElement("div"),
        );

        // Assert
        expect(applyConfig).toHaveBeenCalledWith(config);
    });
});

describe("setTheme handler (override un-freeze)", () => {
    const BG = "--vscode-editor-background";

    beforeEach(() => {
        vi.clearAllMocks();
        document.documentElement.style.removeProperty(BG);
    });

    it("an empty color map should clear the inline overrides a prior push installed", () => {
        // Arrange: a shared themeOverrides set so both pushes see the same state.
        const deps = { ...stubDeps(), themeOverrides: new Set<string>() };
        const handlers = createMessageHandlers(deps);
        const container = document.createElement("div");

        // Act 1: a pinned/custom palette installs an inline --vscode-* override.
        handlers.setTheme?.({ type: "setTheme", colors: { [BG]: "#123456" } }, container);
        expect(document.documentElement.style.getPropertyValue(BG).trim()).toBe("#123456");
        expect(deps.themeOverrides.has(BG)).toBe(true);

        // Act 2: switching to auto sends an empty map, which must REMOVE the
        // override so VS Code's live native variable shows through again — this
        // is the mechanism that un-freezes the theme without a webview reload.
        handlers.setTheme?.({ type: "setTheme", colors: {} }, container);

        // Assert
        expect(document.documentElement.style.getPropertyValue(BG)).toBe("");
        expect(deps.themeOverrides.size).toBe(0);
    });
});
