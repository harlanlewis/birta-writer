/**
 * Whole-toolbar visibility (markdownWysiwyg.toolbar.visible): the gear-menu
 * "Toggle Toolbar" entry, the expand tab shown while hidden, the optimistic
 * setToolbarVisible write, and the toolbarConfig echo path (applyConfig).
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { initToolbar } from "../components/toolbar";
import { initToc } from "../components/toc";
import { EventManager } from "../eventManager";
import { runEditorCommand } from "../editorCommands";
import type { ToolbarConfig } from "../../shared/messages";

type Toolbar = ReturnType<typeof initToolbar>;

function buildToolbar(): { topbar: HTMLElement; tb: Toolbar } {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    const tb = initToolbar(topbar, () => null);
    return { topbar, tb };
}

function config(visible: boolean | undefined): ToolbarConfig {
    return { placements: {}, order: [], ...(visible === undefined ? {} : { visible }) };
}

function gearMenuEntry(topbar: HTMLElement, label: string): HTMLElement | null {
    const entries = topbar.querySelectorAll<HTMLElement>(".tb-settings-menu .tb-fmt-item");
    return Array.from(entries).find((el) => el.textContent === label) ?? null;
}

function expandTab(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".toolbar-toggle-tab");
}

function visibleMessages(): Array<{ type: string; visible?: boolean }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; visible?: boolean })
        .filter((msg) => msg.type === "setToolbarVisible");
}

describe("toolbar visibility", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.body.className = "";
        window.__i18n = undefined;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("by default should render visible with the expand tab present but CSS-hidden", () => {
        // Arrange / Act
        const { topbar } = buildToolbar();

        // Assert — the tab exists (CSS shows it only under body.toolbar-hidden)
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(false);
        expect(document.body.classList.contains("toolbar-hidden")).toBe(false);
        expect(expandTab()).not.toBeNull();
        expect(expandTab()!.getAttribute("aria-label")).toBe("Show toolbar");
    });

    it("a bootstrap config with visible: false should start hidden", () => {
        // Arrange
        window.__i18n = { toolbar: config(false) } as unknown as typeof window.__i18n;

        // Act
        const { topbar } = buildToolbar();

        // Assert — applied at init, without notifying (nothing changed)
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(true);
        expect(document.body.classList.contains("toolbar-hidden")).toBe(true);
        expect(visibleMessages()).toHaveLength(0);
    });

    it("the gear menu should render a product header and the rows in shared-table order", () => {
        // Arrange / Act
        const { topbar } = buildToolbar();

        // Assert — header names the product; rows stay short
        const header = topbar.querySelector(".tb-settings-menu .tb-fmt-header");
        expect(header?.textContent).toBe("WYSIWYG Markdown Editor");
        const rows = Array.from(
            topbar.querySelectorAll(".tb-settings-menu .tb-fmt-item"),
        ).map((el) => el.textContent);
        expect(rows).toEqual([
            "Customize Toolbar",
            "Hide Toolbar",
            "Keyboard Shortcuts",
            "Settings",
        ]);
    });

    it("the gear menu Hide Toolbar entry should hide the bar and persist the setting", () => {
        // Arrange
        const { topbar } = buildToolbar();
        const entry = gearMenuEntry(topbar, "Hide Toolbar");
        expect(entry).not.toBeNull();

        // Act
        entry!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert — optimistic hide + settings write-through
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(true);
        expect(document.body.classList.contains("toolbar-hidden")).toBe(true);
        expect(visibleMessages()).toEqual([{ type: "setToolbarVisible", visible: false }]);
    });

    it("clicking the expand tab while hidden should restore the bar and persist the setting", () => {
        // Arrange
        const { topbar, tb } = buildToolbar();
        tb.applyConfig(config(false));

        // Act
        expandTab()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        // Assert
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(false);
        expect(document.body.classList.contains("toolbar-hidden")).toBe(false);
        expect(visibleMessages()).toEqual([{ type: "setToolbarVisible", visible: true }]);
    });

    it("the expand tab should carry its own toolbarTab context (right-click offers Show Toolbar)", () => {
        // Arrange / Act
        buildToolbar();

        // Assert — VS Code reads this to show the contributed tab menu
        const ctx = JSON.parse(expandTab()!.dataset["vscodeContext"] ?? "{}") as Record<string, unknown>;
        expect(ctx["webviewSection"]).toBe("toolbarTab");
        expect(ctx["preventDefaultContextMenuItems"]).toBe(true);
    });

    it("a toolbarConfig echo should apply visibility without re-notifying", () => {
        // Arrange
        const { topbar, tb } = buildToolbar();

        // Act — the settings round-trip echo, not a user action
        tb.applyConfig(config(false));

        // Assert
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(true);
        expect(visibleMessages()).toHaveLength(0);

        // Act — echo back to visible (e.g. toggled from another editor)
        tb.applyConfig(config(true));
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(false);
        expect(visibleMessages()).toHaveLength(0);
    });

    it("toggling visibility should reposition the TOC panel via the synchronous resize dispatch", () => {
        // Arrange — a topbar whose rect stays stale during the slide transition,
        // and a TOC wired to a real EventManager so it hears the resize event
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
            cb(0);
            return 0;
        });
        const { topbar } = buildToolbar();
        topbar.getBoundingClientRect = () =>
            ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: 40, bottom: 40 }) as DOMRect;
        const em = new EventManager();
        const { panel } = initToc(em, () => null);
        expect(panel.style.top).toBe("40px");

        // Act — hide from the gear menu (applyVisibility dispatches resize synchronously)
        gearMenuEntry(topbar, "Hide Toolbar")!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        // Assert — the panel pins to the top despite the still-animating bar
        expect(panel.style.top).toBe("0px");
        expect(panel.style.height).toBe("calc(100vh - 0px)");

        // Act — show again while the bar is still translated up (bottom reads 0)
        topbar.getBoundingClientRect = () =>
            ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: 40, bottom: 0 }) as DOMRect;
        expandTab()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        // Assert — the panel realigns below the bar, not underneath it
        expect(panel.style.top).toBe("40px");
        em.dispose();
    });

    it("the hideToolbar and showToolbar editor commands should be idempotent state setters", () => {
        // Arrange — initToolbar registers the host hooks
        const { topbar } = buildToolbar();

        // Act / Assert — palette and right-click reach the same code path
        runEditorCommand("hideToolbar", () => null);
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(true);
        runEditorCommand("hideToolbar", () => null); // already hidden: no-op
        runEditorCommand("showToolbar", () => null);
        expect(topbar.classList.contains("editor-topbar--hidden")).toBe(false);
        expect(visibleMessages()).toEqual([
            { type: "setToolbarVisible", visible: false },
            { type: "setToolbarVisible", visible: true },
        ]);
    });
});
