/**
 * messageHandlers.ts tests: table-wrap CSS application, plus the editorCommand
 * dispatch path (MAR-9).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyTableWrap, createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { setEditorCommandHost } from "../editorCommands";
import type { ToWebviewMessage } from "../../shared/messages";

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
        // 清除 CSS 变量
        const root = document.documentElement;
        root.style.removeProperty("--tbl-ow");
    });

    it("aggressive 模式设置 overflow-wrap: anywhere", () => {
        applyTableWrap("aggressive");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("anywhere");
    });

    it("normal 模式设置 overflow-wrap: break-word", () => {
        applyTableWrap("normal");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("break-word");
    });

    it("none 模式设置 overflow-wrap: normal", () => {
        applyTableWrap("none");
        const val = document.documentElement.style.getPropertyValue("--tbl-ow").trim();
        expect(val).toBe("normal");
    });

    it("切换模式时覆盖之前的设置", () => {
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
