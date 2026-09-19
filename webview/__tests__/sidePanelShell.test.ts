/**
 * The side-panel shell (components/sidePanel/shell.ts) on its own, driven with
 * a prefix that is NOT the table of contents' where the question is whether
 * the shell is really parametrized, and with the TOC's own configuration where
 * the question is whether the extraction kept the TOC's numbers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSidePanelShell, SIDE_PANEL_INSET, type SidePanelShell, type SidePanelShellOptions } from "../components/sidePanel/shell";
import { TAB_EDGE_INSET, TAB_TOP_INSET } from "../components/sidePanel/revealTab";
import { FLYOUT_EDGE, FLYOUT_WIDTH } from "../components/sidePanel/flyout";
import type { EventManager } from "../eventManager";

// Registers for real, so a test can drive the shell through the same
// `resize` the window sends it. A stub that recorded the call and listened to
// nothing would leave every resize path here untested while looking wired.
const fakeEventManager = {
    onWindow: vi.fn((type: string, handler: EventListener) => {
        window.addEventListener(type, handler);
        return () => window.removeEventListener(type, handler);
    }),
} as unknown as EventManager;

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
        narrow: { kind: "float", minContentWidth: 600 },
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
    /**
     * Every shell this block builds, torn down after each test.
     *
     * A live shell keeps a window listener and goes on writing the width
     * variable that every shell in this file shares, so one left behind
     * answers the NEXT test's resize. That is a test reading another test's
     * panel, and it looks exactly like the code under test being wrong.
     */
    const built: SidePanelShell[] = [];
    function build(options: SidePanelShellOptions): SidePanelShell {
        const shell = createSidePanelShell(options);
        built.push(shell);
        return shell;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.className = "";
        document.body.innerHTML = "";
        document.documentElement.style.cssText = "";
    });

    afterEach(() => {
        while (built.length > 0) { built.pop()?.dispose(); }
        setViewportWidth(originalInnerWidth);
    });

    it("a viewport that holds the drawer plus the content column should dock", () => {
        setViewportWidth(820); // 220 + 600 exactly
        const shell = build(filesOptions());
        expect(shell.settleMode()).toBe("docked");
    });

    it("a viewport one pixel short should float", () => {
        setViewportWidth(819);
        const shell = build(filesOptions());
        expect(shell.settleMode()).toBe("overlay");
    });

    it("a neighbour's reserve should be taken off the viewport before the decision", () => {
        setViewportWidth(900); // room for 220 + 600, until a neighbour takes 100
        const shell = build(filesOptions({ neighborReserve: () => 100 }));
        expect(shell.settleMode()).toBe("overlay");
    });

    it("the neighbour should be told when, and only when, the docked footprint moves", () => {
        setViewportWidth(1200);
        const onReserveChange = vi.fn();
        const shell = build(filesOptions({ onReserveChange }));
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
        const shell = build(filesOptions({ neighborReserve: () => neighbour }));
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
        const shell = build(filesOptions({ openOnDock }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        expect(shell.isOpen()).toBe(false);

        setViewportWidth(1200);
        shell.checkResponsiveMode();

        expect(openOnDock).toHaveBeenCalledTimes(1);
        expect(shell.isOpen()).toBe(true);
        expect(document.body.classList.contains("files-open")).toBe(true);
    });

    it("a drawer that holds the dock should stay docked at a width that would float a floating one", () => {
        setViewportWidth(300); // narrower than the drawer plus any content at all
        const float = build(filesOptions());
        const hold = build(filesOptions({ narrow: { kind: "hold" } }));
        // Both arms, so a viewport that floated nothing cannot pass this by
        // agreeing with itself: the pair is the measurement.
        expect(float.settleMode()).toBe("overlay");
        expect(hold.settleMode()).toBe("docked");
    });

    it("a drawer that holds the dock should not close itself when the viewport narrows", () => {
        setViewportWidth(1200);
        const openOnDock = vi.fn(() => true);
        const shell = build(filesOptions({ narrow: { kind: "hold" }, openOnDock }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();

        setViewportWidth(400);
        shell.checkResponsiveMode();

        expect(shell.mode()).toBe("docked");
        expect(shell.isOpen()).toBe(true);
        expect(document.body.classList.contains("files-open")).toBe(true);
        // Never asked, because the mode never moved: nothing reopened it, so
        // what is on screen is the state the reader left.
        expect(openOnDock).not.toHaveBeenCalled();
    });

    it("a drawer that holds the dock should not be drawn wider than its window", () => {
        setViewportWidth(1200);
        const onCommit = vi.fn();
        const shell = build(filesOptions({
            narrow: { kind: "hold" },
            width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit },
        }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        shell.setWidth(480); // the reader drags it wide
        const wide = document.documentElement.style.getPropertyValue("--files-width");

        setViewportWidth(400); // ...and then makes the window narrower than it
        window.dispatchEvent(new Event("resize"));

        const drawn = parseInt(document.documentElement.style.getPropertyValue("--files-width"), 10);
        expect(wide).toBe("480px");
        expect(drawn).toBeLessThan(400);
        // A strip of document is still there to click into, and the drawer's
        // own reserve agrees with what is drawn rather than with what was
        // stored: the content's margin reads the same variable.
        expect(400 - drawn).toBeGreaterThanOrEqual(100);
        expect(shell.dockedReserve()).toBe(drawn);
        // The reader's width is kept rather than rewritten, so the room
        // coming back brings it back (below), and nothing was committed to
        // the host: a window resize is not the reader settling on a width.
        expect(onCommit).not.toHaveBeenCalled();
        setViewportWidth(1200);
        window.dispatchEvent(new Event("resize"));
        expect(document.documentElement.style.getPropertyValue("--files-width")).toBe("480px");
    });

    it("a drag against the pin should store the width that was drawn", () => {
        // The pair to the test above: there the window moves and the reader's
        // width is kept, here the READER moves and what they could see is what
        // is kept. Without it the shell holds a width nothing ever drew.
        setViewportWidth(400);
        const onCommit = vi.fn();
        const shell = build(filesOptions({
            narrow: { kind: "hold" },
            width: { cssVar: "--files-width", default: 220, min: 180, max: 480, onCommit },
        }));
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        const handle = shell.panel.querySelector<HTMLElement>(".side-panel-resize-handle")!;

        handle.dispatchEvent(mouse("mousedown", 220));
        document.dispatchEvent(mouse("mousemove", 460)); // drag well past the pin
        document.dispatchEvent(mouse("mouseup", 460));

        const drawn = parseInt(document.documentElement.style.getPropertyValue("--files-width"), 10);
        expect(drawn).toBe(400 - 120);
        expect(onCommit).toHaveBeenCalledWith(drawn);
        expect(shell.width()).toBe(drawn);
    });

    it("a floating drawer's width should be untouched by the viewport", () => {
        // The arm that says the clamp above belongs to the policy rather than
        // to the shell: the same narrow window leaves a floating drawer's
        // width exactly where the reader put it.
        setViewportWidth(1200);
        const shell = build(filesOptions());
        document.body.appendChild(shell.panel);
        shell.settleMode();
        shell.open();
        shell.setWidth(420);
        setViewportWidth(400);
        window.dispatchEvent(new Event("resize"));
        expect(document.documentElement.style.getPropertyValue("--files-width")).toBe("420px");
    });

    it("a neighbour's reserve should not float a drawer that holds the dock either", () => {
        setViewportWidth(900);
        const shell = build(filesOptions({
            narrow: { kind: "hold" },
            neighborReserve: () => 800,
        }));
        expect(shell.settleMode()).toBe("docked");
    });

    it("a responsive flip to overlay should close the panel and hand focus back", () => {
        setViewportWidth(1200);
        const focusEditor = vi.fn();
        const shell = build(filesOptions({ focusEditor }));
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

    it("a leading panel's flyout off a trigger near the trailing edge should be held inside the window", () => {
        // The file explorer's case: it docks on the leading edge and its
        // button sits in the bar's trailing cluster, so a card lined up with
        // the button's leading edge would run off the end of the window.
        const shell = createSidePanelShell(filesOptions({ trigger: { kind: "external" } }));
        document.body.appendChild(shell.panel);
        const button = document.createElement("button");
        button.getBoundingClientRect = () => new DOMRect(window.innerWidth - 60, 5, 26, 24);
        document.body.appendChild(button);
        shell.setFlyoutTrigger(button);

        button.dispatchEvent(new MouseEvent("mouseenter"));
        const left = parseFloat(shell.panel.style.left);
        expect(left + FLYOUT_WIDTH).toBeLessThanOrEqual(window.innerWidth - FLYOUT_EDGE);
        // And no further in than it has to be: the card still ends at the edge
        // its trigger is against.
        expect(left).toBe(window.innerWidth - FLYOUT_WIDTH - FLYOUT_EDGE);
    });

    it("a flyout with room should still line up with its trigger", () => {
        const shell = createSidePanelShell(filesOptions({ trigger: { kind: "external" } }));
        document.body.appendChild(shell.panel);
        const button = document.createElement("button");
        button.getBoundingClientRect = () => new DOMRect(120, 5, 26, 24);
        document.body.appendChild(button);
        shell.setFlyoutTrigger(button);

        button.dispatchEvent(new MouseEvent("mouseenter"));
        expect(shell.panel.style.left).toBe("120px");
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
            narrow: { kind: "float", minContentWidth: 720 },
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

    // With no inset, which is the shell's default rather than any drawer's:
    // both composers stand in by `SIDE_PANEL_INSET`, and the case below is
    // what holds the default itself untouched.
    it("a drawer flush to the frame should land its tab at the edge inset and the topbar's bottom plus the top inset", () => {
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

    // The tab is `position: fixed` and the hide button it has to land on
    // rides the panel, so a drawer that stands in from the window takes the
    // button in with it. Without this the glyph jumps by the inset on every
    // toggle, and nothing else in the suite would say so: the cases above
    // build a shell with no inset at all.
    //
    // The two axes are NOT symmetric, and the last assertion is what holds
    // that: the drawer stands in at its docked edge and is flush with the
    // chrome above it, so the tab takes the inset sideways and not
    // vertically. An inset added to both, which is what this did while the
    // drawer took one at the top, now puts the tab a whole inset below the
    // button it is meant to sit over.
    it("a drawer standing in from the window should take its reveal tab in by the same amount", () => {
        addTopbar(40);
        const shell = createSidePanelShell({ ...tocOptions(), inset: SIDE_PANEL_INSET, initialRight: true });
        shell.updatePosition();
        shell.sync();
        const tab = document.querySelector<HTMLElement>(".toc-toggle-tab")!;
        expect(tab.style.right).toBe(`${TAB_EDGE_INSET + SIDE_PANEL_INSET}px`);
        expect(tab.style.top).toBe(`${40 + TAB_TOP_INSET}px`);
        // And the tab keeps its offset FROM THE PANEL, which is the whole of
        // what makes the glyph sit still.
        expect(parseFloat(tab.style.top) - parseFloat(shell.panel.style.top)).toBe(TAB_TOP_INSET);
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
