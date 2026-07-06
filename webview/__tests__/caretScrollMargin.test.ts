/**
 * Tests for the caret scroll-margin plugin: per-side scrollThreshold /
 * scrollMargin insets that keep the caret clear of the fixed topbar and
 * sticky heading title, plus the scroll-padding CSS-var mirror.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    bodyLineHeightPx,
    caretScrollInsets,
    computeInsets,
    createCaretScrollMarginPlugin,
    measureStickyHeadingHeight,
    syncScrollPaddingVars,
} from "../plugins/caretScrollMargin";

function mountRect(element: HTMLElement, rect: Partial<DOMRect>): void {
    element.getBoundingClientRect = () =>
        ({
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
            ...rect,
        }) as DOMRect;
}

function addTopbar(bottom: number): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    mountRect(topbar, { bottom, height: bottom });
    document.body.appendChild(topbar);
    return topbar;
}

function addSticky(height: number, hidden = false): HTMLElement {
    const sticky = document.createElement("div");
    sticky.className = "heading-sticky-title";
    sticky.hidden = hidden;
    mountRect(sticky, { height });
    document.body.appendChild(sticky);
    return sticky;
}

describe("caretScrollMargin insets", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.documentElement.style.removeProperty("--caret-scroll-top-inset");
        document.documentElement.style.removeProperty("--caret-scroll-bottom-inset");
    });

    afterEach(() => {
        document.body.innerHTML = "";
    });

    it("bodyLineHeightPx without a usable computed style should fall back to a positive default", () => {
        // jsdom reports line-height "normal" (non-numeric), taking the fallback path.
        const px = bodyLineHeightPx();
        expect(px).toBeGreaterThan(0);
        expect(Number.isFinite(px)).toBe(true);
    });

    it("measureStickyHeadingHeight with a visible sticky title should return its measured height", () => {
        addSticky(42);
        expect(measureStickyHeadingHeight()).toBe(42);
    });

    it("measureStickyHeadingHeight with the sticky hidden should reserve an estimated line instead of 0", () => {
        addSticky(42, true);
        const estimate = measureStickyHeadingHeight();
        expect(estimate).toBeGreaterThan(0);
        expect(estimate).not.toBe(42);
    });

    it("computeInsets should stack topbar bottom + sticky height + one line of air on top", () => {
        addTopbar(40);
        addSticky(36);
        const { top } = computeInsets();
        expect(top).toBeGreaterThanOrEqual(40 + 36);
        expect(top).toBe(Math.round(40 + 36 + bodyLineHeightPx()));
    });

    it("computeInsets without a topbar in the DOM should use the 40px fallback", () => {
        addSticky(36);
        expect(computeInsets().top).toBe(Math.round(40 + 36 + bodyLineHeightPx()));
    });

    it("computeInsets should reserve about 2.5 lines of bottom context", () => {
        expect(computeInsets().bottom).toBe(Math.round(bodyLineHeightPx() * 2.5));
    });

    it("a short viewport should shrink the bottom band so top+bottom bands never overlap", () => {
        addTopbar(40);
        addSticky(36);
        const line = bodyLineHeightPx();
        vi.stubGlobal("innerHeight", 150);
        try {
            const { top, bottom } = computeInsets();
            // Hard occlusion (topbar + sticky) keeps priority...
            expect(top).toBe(Math.round(40 + 36 + line));
            // ...while the bottom comfort band gives way, leaving >= 2 lines
            // of free space so ProseMirror's top/bottom corrections cannot
            // oscillate on consecutive keystrokes.
            expect(bottom).toBeLessThan(Math.round(line * 2.5));
            expect(top + bottom).toBeLessThanOrEqual(Math.ceil(150 - line * 2) + 1);
            expect(bottom).toBeGreaterThanOrEqual(5);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("a pathologically short viewport should sacrifice header clearance last but keep a caret line usable", () => {
        addTopbar(40);
        addSticky(36);
        const line = bodyLineHeightPx();
        vi.stubGlobal("innerHeight", 100);
        try {
            const { top, bottom } = computeInsets();
            expect(bottom).toBe(5);
            expect(top).toBeLessThan(Math.round(40 + 36 + line));
            expect(top).toBeGreaterThanOrEqual(0);
            expect(top + bottom).toBeLessThanOrEqual(Math.ceil(100 - line * 2) + 1);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("caretScrollInsets.top should re-measure the DOM on every read", () => {
        const topbar = addTopbar(40);
        addSticky(36);
        const before = caretScrollInsets.top;
        mountRect(topbar, { bottom: 90, height: 90 });
        const after = caretScrollInsets.top;
        expect(after).toBe(before + 50);
    });

    it("caretScrollInsets should keep ProseMirror's 5px horizontal defaults", () => {
        expect(caretScrollInsets.left).toBe(5);
        expect(caretScrollInsets.right).toBe(5);
    });
});

describe("caretScrollMargin plugin wiring", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        document.documentElement.style.removeProperty("--caret-scroll-top-inset");
        document.documentElement.style.removeProperty("--caret-scroll-bottom-inset");
    });

    it("plugin props should expose the live insets as both scrollThreshold and scrollMargin", () => {
        const plugin = createCaretScrollMarginPlugin();
        expect(plugin.props.scrollThreshold).toBe(caretScrollInsets);
        expect(plugin.props.scrollMargin).toBe(caretScrollInsets);
    });

    it("syncScrollPaddingVars should mirror the insets into root CSS variables", () => {
        addTopbar(40);
        addSticky(36);
        const applied = syncScrollPaddingVars();
        const rootStyle = document.documentElement.style;
        expect(rootStyle.getPropertyValue("--caret-scroll-top-inset")).toBe(`${applied}px`);
        expect(rootStyle.getPropertyValue("--caret-scroll-bottom-inset")).toBe(
            `${computeInsets().bottom}px`,
        );
        expect(applied).toBe(computeInsets().top);
    });

    it("plugin view should sync CSS vars on creation and stop listening after destroy", () => {
        vi.useFakeTimers();
        try {
            addTopbar(40);
            const sticky = addSticky(30);
            const plugin = createCaretScrollMarginPlugin();
            const spec = plugin.spec as {
                view?: (view: unknown) => { destroy?: () => void };
            };
            const pluginView = spec.view?.({});
            const rootStyle = document.documentElement.style;
            const initial = rootStyle.getPropertyValue("--caret-scroll-top-inset");
            expect(initial).toBe(`${computeInsets().top}px`);

            // A scroll after a sticky-height change refreshes the vars (rAF-throttled).
            mountRect(sticky, { height: 60 });
            window.dispatchEvent(new Event("scroll"));
            vi.advanceTimersByTime(50);
            const refreshed = rootStyle.getPropertyValue("--caret-scroll-top-inset");
            expect(refreshed).toBe(`${computeInsets().top}px`);
            expect(refreshed).not.toBe(initial);

            // After destroy, further scrolls no longer touch the vars.
            pluginView?.destroy?.();
            rootStyle.setProperty("--caret-scroll-top-inset", "1px");
            window.dispatchEvent(new Event("scroll"));
            vi.advanceTimersByTime(50);
            expect(rootStyle.getPropertyValue("--caret-scroll-top-inset")).toBe("1px");
        } finally {
            vi.useRealTimers();
        }
    });
});
