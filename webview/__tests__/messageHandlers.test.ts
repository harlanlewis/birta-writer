/**
 * messageHandlers.ts tests: table-wrap CSS application, plus the editorCommand
 * dispatch path (MAR-9).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { applyTableWrap, applyGutterMarkers, createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
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

describe("applyGutterMarkers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.classList.remove("gutter-rest-none", "gutter-rest-all");
    });

    it("the none mode should add gutter-rest-none only", () => {
        applyGutterMarkers("none");
        expect(document.body.classList.contains("gutter-rest-none")).toBe(true);
        expect(document.body.classList.contains("gutter-rest-all")).toBe(false);
    });

    it("the all mode should add gutter-rest-all only", () => {
        applyGutterMarkers("all");
        expect(document.body.classList.contains("gutter-rest-all")).toBe(true);
        expect(document.body.classList.contains("gutter-rest-none")).toBe(false);
    });

    it("switching modes should replace the previous class", () => {
        applyGutterMarkers("none");
        applyGutterMarkers("all");
        expect(document.body.classList.contains("gutter-rest-none")).toBe(false);
        expect(document.body.classList.contains("gutter-rest-all")).toBe(true);
    });

    it("the headings mode should clear both override classes", () => {
        applyGutterMarkers("all");
        applyGutterMarkers("headings");
        expect(document.body.classList.contains("gutter-rest-none")).toBe(false);
        expect(document.body.classList.contains("gutter-rest-all")).toBe(false);
    });

    it("an unknown mode should behave as the default (headings)", () => {
        applyGutterMarkers("all");
        applyGutterMarkers("hover" as never);
        expect(document.body.classList.contains("gutter-rest-none")).toBe(false);
        expect(document.body.classList.contains("gutter-rest-all")).toBe(false);
    });
});

describe("setGutterMarkers handler", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.classList.remove("gutter-rest-none", "gutter-rest-all");
    });

    it("a setGutterMarkers message should apply the mode's body class", () => {
        // Arrange
        const handlers = createMessageHandlers(stubDeps());

        // Act
        handlers.setGutterMarkers?.(
            { type: "setGutterMarkers", mode: "all" },
            document.createElement("div"),
        );

        // Assert
        expect(document.body.classList.contains("gutter-rest-all")).toBe(true);
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
