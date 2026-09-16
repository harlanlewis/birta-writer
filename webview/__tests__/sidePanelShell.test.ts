/**
 * The side-panel shell (components/sidePanel/shell.ts) on its own, driven with
 * a prefix that is NOT the table of contents' where the question is whether
 * the shell is really parametrized, and with the TOC's own configuration where
 * the question is whether the extraction kept the TOC's numbers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSidePanelShell, type SidePanelShellOptions } from "../components/sidePanel/shell";
import { TAB_EDGE_INSET, TAB_TOP_INSET } from "../components/sidePanel/revealTab";
import type { EventManager } from "../eventManager";

const fakeEventManager = { onWindow: vi.fn() } as unknown as EventManager;

function addTopbar(bottom: number): void {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    topbar.getBoundingClientRect = () =>
        ({ x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: bottom, bottom }) as DOMRect;
    document.body.appendChild(topbar);
}

function setViewportWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
}

/** A second composer's configuration: nothing here is the TOC's. */
function filesOptions(overrides: Partial<SidePanelShellOptions> = {}): SidePanelShellOptions {
    return {
        prefix: "files",
        eventManager: fakeEventManager,
        initialRight: false,
        width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit: vi.fn() },
        dockedMinContentWidth: 600,
        trigger: { kind: "tab", tooltip: "Show files" },
        openOnDock: () => true,
        renderBody: vi.fn(),
        focusEditor: vi.fn(),
        ...overrides,
    };
}

function mouse(type: string, clientX: number): MouseEvent {
    return new MouseEvent(type, { button: 0, clientX, bubbles: true });
}

describe("side-panel shell: open state and body classes", () => {
    const originalInnerWidth = window.innerWidth;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
        document.documentElement.style.cssText = "";
    });

    afterEach(() => {
        setViewportWidth(originalInnerWidth);
    });

    it("a docked open should write the prefixed body class and both panel vocabularies", () => {
        setViewportWidth(1200);
        const shell = createSidePanelShell(filesOptions());
        document.body.appendChild(shell.panel);
        shell.settleMode();

        shell.open();

        expect(shell.mode()).toBe("docked");
        expect(document.body.classList.contains("files-open")).toBe(true);
        expect(document.body.classList.contains("files-docked")).toBe(true);
        expect(document.body.classList.contains("files-overlay-open")).toBe(false);
        expect(shell.panel.classList.contains("side-panel--open")).toBe(true);
        expect(shell.panel.classList.contains("files-panel--open")).toBe(true);
        // Nothing of the first composer leaks through the prefix.
        expect(document.body.className).not.toContain("toc");
        expect(shell.panel.className).not.toContain("toc");
    });

    it("close should clear the open classes and render nothing", () => {
        setViewportWidth(1200);
        const renderBody = vi.fn();
        const shell = createSidePanelShell(filesOptions({ renderBody }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        renderBody.mockClear();

        shell.close();

        expect(shell.isOpen()).toBe(false);
        expect(document.body.classList.contains("files-open")).toBe(false);
        expect(shell.panel.classList.contains("side-panel--open")).toBe(false);
        expect(renderBody).not.toHaveBeenCalled();
    });

    it("an overlay open should write the overlay-open body class, not the docked one", () => {
        setViewportWidth(700); // < 220 + 600
        const shell = createSidePanelShell(filesOptions());
        document.body.appendChild(shell.panel);
        shell.settleMode();

        shell.open();

        expect(shell.mode()).toBe("overlay");
        expect(document.body.classList.contains("files-overlay-open")).toBe(true);
        expect(document.body.classList.contains("files-open")).toBe(false);
    });

    it("setOpen should record without committing, and sync should commit it", () => {
        setViewportWidth(1200);
        const shell = createSidePanelShell(filesOptions());
        document.body.appendChild(shell.panel);
        shell.settleMode();

        shell.setOpen(true);
        expect(document.body.classList.contains("files-open")).toBe(false);

        shell.sync();
        expect(document.body.classList.contains("files-open")).toBe(true);
    });

    it("a commit under suppressTransitions should leave no initial class behind", () => {
        setViewportWidth(1200);
        const shell = createSidePanelShell(filesOptions({ suppressTransitions: () => true }));
        document.body.appendChild(shell.panel);
        shell.settleMode();

        shell.open();

        expect(document.body.classList.contains("files-initial")).toBe(false);
        expect(shell.panel.classList.contains("side-panel--instant")).toBe(false);
    });
});

describe("side-panel shell: docked vs overlay from the viewport", () => {
    const originalInnerWidth = window.innerWidth;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
    });

    afterEach(() => {
        setViewportWidth(originalInnerWidth);
    });

    it("a viewport that holds the drawer plus the content column should dock", () => {
        setViewportWidth(820); // 220 + 600 exactly
        const shell = createSidePanelShell(filesOptions());
        expect(shell.settleMode()).toBe("docked");
    });

    it("a viewport one pixel short should float", () => {
        setViewportWidth(819);
        const shell = createSidePanelShell(filesOptions());
        expect(shell.settleMode()).toBe("overlay");
    });

    it("a neighbour's reserve should be taken off the viewport before the decision", () => {
        setViewportWidth(900); // room for 220 + 600, until a neighbour takes 100
        const shell = createSidePanelShell(filesOptions({ neighborReserve: () => 100 }));
        expect(shell.settleMode()).toBe("overlay");
    });

    it("the neighbour should be told when, and only when, the docked footprint moves", () => {
        setViewportWidth(1200);
        const onReserveChange = vi.fn();
        const shell = createSidePanelShell(filesOptions({ onReserveChange }));
        shell.settleMode();
        expect(shell.dockedReserve()).toBe(0);
        shell.open();
        expect(shell.dockedReserve()).toBe(220);
        expect(onReserveChange).toHaveBeenCalledTimes(1);
        shell.sync(); // a re-render with nothing moved
        expect(onReserveChange).toHaveBeenCalledTimes(1);
        shell.setWidth(300); // wider while docked open: the footprint grew
        expect(shell.dockedReserve()).toBe(300);
        expect(onReserveChange).toHaveBeenCalledTimes(2);
        setViewportWidth(700); // 300 + 600 no longer fits: the flip frees the room
        shell.checkResponsiveMode();
        expect(shell.mode()).toBe("overlay");
        expect(shell.dockedReserve()).toBe(0);
        expect(onReserveChange).toHaveBeenCalledTimes(3);
        shell.close(); // closed overlay to closed overlay: nothing moved
        expect(onReserveChange).toHaveBeenCalledTimes(3);
    });

    it("a neighbour opening should be able to float this panel through checkResponsiveMode", () => {
        setViewportWidth(900); // room for 220 + 600 alone
        let neighbour = 0;
        const shell = createSidePanelShell(filesOptions({ neighborReserve: () => neighbour }));
        shell.settleMode();
        shell.open();
        expect(shell.mode()).toBe("docked");
        neighbour = 100; // the other panel docked open
        shell.checkResponsiveMode();
        expect(shell.mode()).toBe("overlay");
        expect(shell.isOpen()).toBe(false);
        neighbour = 0;
        shell.checkResponsiveMode();
        expect(shell.mode()).toBe("docked");
    });

    it("a responsive flip to docked should ask the composer whether to reopen", () => {
        setViewportWidth(700);
        const openOnDock = vi.fn(() => true);
        const shell = createSidePanelShell(filesOptions({ openOnDock }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        expect(shell.isOpen()).toBe(false);

        setViewportWidth(1200);
        shell.checkResponsiveMode();

        expect(openOnDock).toHaveBeenCalledTimes(1);
        expect(shell.isOpen()).toBe(true);
        expect(document.body.classList.contains("files-open")).toBe(true);
    });

    it("a responsive flip to overlay should close the panel and hand focus back", () => {
        setViewportWidth(1200);
        const focusEditor = vi.fn();
        const shell = createSidePanelShell(filesOptions({ focusEditor }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        const inside = document.createElement("button");
        shell.panel.appendChild(inside);
        inside.focus();
        expect(document.activeElement).toBe(inside);

        setViewportWidth(700);
        shell.checkResponsiveMode();

        expect(shell.isOpen()).toBe(false);
        expect(focusEditor).toHaveBeenCalledTimes(1);
    });
});

describe("side-panel shell: width", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
        document.documentElement.style.cssText = "";
    });

    function handleOf(panel: HTMLElement): HTMLElement {
        return panel.querySelector<HTMLElement>(".side-panel-resize-handle")!;
    }

    it("the handle should carry both the generic and the prefixed class", () => {
        const shell = createSidePanelShell(filesOptions());
        const handle = handleOf(shell.panel);
        expect(handle).not.toBeNull();
        expect(handle.classList.contains("files-resize-handle")).toBe(true);
    });

    it("a drag should write the composer's variable per move and commit once, on mouseup", () => {
        const onCommit = vi.fn();
        const shell = createSidePanelShell(filesOptions({
            width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit },
        }));
        const handle = handleOf(shell.panel);

        handle.dispatchEvent(mouse("mousedown", 220));
        document.dispatchEvent(mouse("mousemove", 300));
        expect(document.documentElement.style.getPropertyValue("--files-width")).toBe("300px");
        expect(onCommit).not.toHaveBeenCalled();
        expect(document.body.classList.contains("files-resizing")).toBe(true);

        document.dispatchEvent(mouse("mouseup", 300));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(300);
        expect(shell.width()).toBe(300);
        expect(document.body.classList.contains("files-resizing")).toBe(false);
    });

    it("a drag past the bounds should clamp to the composer's max and min", () => {
        const shell = createSidePanelShell(filesOptions());
        const handle = handleOf(shell.panel);

        handle.dispatchEvent(mouse("mousedown", 220));
        document.dispatchEvent(mouse("mousemove", 2000));
        document.dispatchEvent(mouse("mouseup", 2000));
        expect(shell.width()).toBe(480);

        handle.dispatchEvent(mouse("mousedown", 480));
        document.dispatchEvent(mouse("mousemove", 0));
        document.dispatchEvent(mouse("mouseup", 0));
        expect(shell.width()).toBe(180);
    });

    it("an unchanged width on mouseup should not commit", () => {
        const onCommit = vi.fn();
        const shell = createSidePanelShell(filesOptions({
            width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit },
        }));
        const handle = handleOf(shell.panel);
        handle.dispatchEvent(mouse("mousedown", 220));
        document.dispatchEvent(mouse("mouseup", 220));
        expect(onCommit).not.toHaveBeenCalled();
    });

    it("a double-click should reset to the composer's default and commit it", () => {
        const onCommit = vi.fn();
        const shell = createSidePanelShell(filesOptions({
            width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit },
        }));
        shell.setWidth(400);
        handleOf(shell.panel).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        expect(shell.width()).toBe(220);
        expect(onCommit).toHaveBeenCalledWith(220);
    });

    it("the panel should bind its width to the composer's variable, never the TOC's", () => {
        const shell = createSidePanelShell(filesOptions());
        expect(shell.panel.style.getPropertyValue("--side-panel-width")).toContain("--files-width");
    });
});

describe("side-panel shell: the reveal tab and the flyout trigger", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
    });

    it("trigger kind tab should put the tab on the page, wired to the composer's activation", () => {
        const onTabActivate = vi.fn();
        const shell = createSidePanelShell(filesOptions({ onTabActivate }));
        const tab = document.querySelector<HTMLElement>(".files-toggle-tab");
        expect(tab).toBe(shell.tabEl);
        expect(tab!.classList.contains("side-panel-tab")).toBe(true);

        tab!.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
        expect(onTabActivate).toHaveBeenCalledTimes(1);
    });

    it("trigger kind external should build the tab but never append it", () => {
        const shell = createSidePanelShell(filesOptions({ trigger: { kind: "external" } }));
        expect(shell.tabEl).toBeInstanceOf(HTMLElement);
        expect(document.querySelector(".files-toggle-tab")).toBeNull();
        expect(document.body.contains(shell.tabEl)).toBe(false);
    });

    it("under an external trigger, setFlyoutTrigger should make that element the flyout's anchor and arm it", () => {
        const renderBody = vi.fn();
        const shell = createSidePanelShell(filesOptions({ trigger: { kind: "external" }, renderBody }));
        document.body.appendChild(shell.panel);
        const button = document.createElement("button");
        document.body.appendChild(button);

        shell.setFlyoutTrigger(button);
        expect(shell.flyoutTrigger()).toBe(button);

        button.dispatchEvent(new MouseEvent("mouseenter"));
        expect(shell.isFlyoutOpen()).toBe(true);
        expect(renderBody).toHaveBeenCalledTimes(1);
        expect(document.body.classList.contains("files-flyout-open")).toBe(true);
        expect(shell.panel.classList.contains("side-panel--flyout")).toBe(true);
        expect(shell.panel.classList.contains("files-panel--flyout")).toBe(true);
    });

    it("under a tab trigger, setFlyoutTrigger should be refused so the tab stays the only trigger", () => {
        const shell = createSidePanelShell(filesOptions());
        const button = document.createElement("button");
        document.body.appendChild(button);

        shell.setFlyoutTrigger(button);

        expect(shell.flyoutTrigger()).toBe(shell.tabEl);
        button.dispatchEvent(new MouseEvent("mouseenter"));
        expect(shell.isFlyoutOpen()).toBe(false);
    });

    it("opening the panel should conceal the tab, closing it should reveal it again", () => {
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
        const shell = createSidePanelShell(filesOptions());
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        expect(shell.tabEl.classList.contains("side-panel-tab--concealed")).toBe(true);
        shell.close();
        expect(shell.tabEl.classList.contains("side-panel-tab--concealed")).toBe(false);
    });
});

describe("side-panel shell: the table of contents' own numbers", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
    });

    function tocOptions(): SidePanelShellOptions {
        return {
            prefix: "toc",
            eventManager: fakeEventManager,
            initialRight: false,
            width: { cssVar: "--toc-width", default: 260, min: 240, max: 600, onCommit: vi.fn() },
            dockedMinContentWidth: 720,
            trigger: { kind: "tab", tooltip: "Show table of contents" },
            openOnDock: () => false,
            renderBody: vi.fn(),
            focusEditor: vi.fn(),
        };
    }

    it("the reveal tab's insets should be the constants the TOC carried before the extraction", () => {
        expect(TAB_EDGE_INSET).toBe(7);
        expect(TAB_TOP_INSET).toBe(7);
    });

    it("the tab should land at the edge inset and at the topbar's bottom plus the top inset", () => {
        addTopbar(40);
        const shell = createSidePanelShell(tocOptions());
        shell.updatePosition();
        shell.sync();
        const tab = document.querySelector<HTMLElement>(".toc-toggle-tab")!;
        expect(tab.style.left).toBe("7px");
        expect(tab.style.right).toBe("auto");
        expect(tab.style.top).toBe("47px");
        expect(shell.panel.style.top).toBe("40px");
        expect(shell.panel.style.height).toBe("calc(100vh - 40px)");
    });

    it("a right-docked TOC should pin the tab to the right edge and mark the panel right", () => {
        const shell = createSidePanelShell({ ...tocOptions(), initialRight: true });
        shell.sync();
        const tab = document.querySelector<HTMLElement>(".toc-toggle-tab")!;
        expect(tab.style.right).toBe("7px");
        expect(tab.style.left).toBe("auto");
        expect(shell.panel.classList.contains("toc-panel--right")).toBe(true);
        expect(shell.panel.classList.contains("side-panel--right")).toBe(true);
    });

    it("the panel should carry both the shell's and the TOC's class", () => {
        const shell = createSidePanelShell(tocOptions());
        expect(shell.panel.classList.contains("side-panel")).toBe(true);
        expect(shell.panel.classList.contains("toc-panel")).toBe(true);
    });
});
