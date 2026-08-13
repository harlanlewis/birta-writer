/**
 * Toolbar Logseq badge: hidden by default, pinned (non-draggable) just after
 * the disk-drift badge, shown by the extension's logseqState message, and
 * clicking it opens the setting that decides whether it appears at all.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initToolbar } from "../components/toolbar";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { TOOLBAR_ITEM_IDS } from "../components/toolbar/registry";
import { mockVscodeApi } from "./setup";

type Controller = ReturnType<typeof initToolbar>;

function buildToolbar(): { topbar: HTMLElement; controller: Controller } {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    const controller = initToolbar(topbar, () => null);
    return { topbar, controller };
}

function findBadgeItem(topbar: HTMLElement): HTMLElement | null {
    return topbar.querySelector<HTMLElement>('.tb-item[data-item-id="logseq"]');
}

describe("toolbar Logseq badge", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("should render hidden by default, right behind the disk-drift badge", () => {
        const { topbar } = buildToolbar();

        const item = findBadgeItem(topbar);
        expect(item).not.toBeNull();
        expect(item!.style.display).toBe("none");
        const rightZone = topbar.querySelector(".tb-zone--right")!;
        // A warning outranks a mode indicator, so drift stays first.
        expect(rightZone.children[0]!.getAttribute("data-item-id")).toBe("syncConflict");
        expect(rightZone.children[1]).toBe(item);
    });

    it("should be a word rather than a glyph, so no icon has to be learned", () => {
        const { topbar } = buildToolbar();
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        expect(button.textContent).toBe("Logseq");
        expect(button.querySelector("svg"), "the badge names a format; it is text").toBeNull();
    });

    it("should compose the .ui-btn primitive its surface class depends on", () => {
        // A composed button is BROKEN without the primitive class (AGENTS.md,
        // "Chrome skin"): the surface class only carries the differences.
        const { topbar } = buildToolbar();
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        expect(button.classList.contains("ui-btn")).toBe(true);
        expect(button.classList.contains("tb-logseq-btn")).toBe(true);
    });

    it("setLogseq(reason) should show the badge; setLogseq(null) should hide it again", () => {
        const { topbar, controller } = buildToolbar();
        const item = findBadgeItem(topbar)!;

        controller.setLogseq("graph");
        expect(item.style.display).toBe("");
        controller.setLogseq(null);
        expect(item.style.display).toBe("none");
    });

    it("each reason should carry its own explanation, on one unchanged treatment", () => {
        // One drawing, three tooltips: what the user ACTS on is identical in
        // all three cases, so only the "why" differs (DESIGN_PRINCIPLES.md,
        // "One treatment per meaning, and no more").
        const { topbar, controller } = buildToolbar();
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        const seen = new Set<string>();
        const className = button.className;
        for (const reason of ["graph", "content", "forced"] as const) {
            controller.setLogseq(reason);
            button.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
            const tip = document.querySelector<HTMLElement>(".custom-tooltip");
            expect(tip, "hovering the badge should surface a tooltip").not.toBeNull();
            expect(tip!.textContent, `${reason} should explain itself`).not.toBe("");
            seen.add(tip!.textContent ?? "");
            button.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
            expect(button.className, "the drawing must not change with the reason").toBe(className);
        }
        expect(seen.size, "three reasons, three explanations").toBe(3);
    });

    it("clicking the visible badge should open the setting that governs it", () => {
        const { topbar, controller } = buildToolbar();
        controller.setLogseq("graph");
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "openSettings",
            query: "birta.logseq",
        });
    });

    it("a logseqState message should drive the toolbar controller's badge state", () => {
        const setLogseq = vi.fn();
        const deps = {
            state: {} as MessageHandlerDeps["state"],
            actions: {} as MessageHandlerDeps["actions"],
            topbarTb: { setLogseq } as unknown as MessageHandlerDeps["topbarTb"],
        } as MessageHandlerDeps;
        const handlers = createMessageHandlers(deps);
        const container = document.createElement("div");

        handlers.logseqState?.({ type: "logseqState", reason: "graph" }, container);
        handlers.logseqState?.({ type: "logseqState", reason: null }, container);

        expect(setLogseq).toHaveBeenNthCalledWith(1, "graph");
        expect(setLogseq).toHaveBeenNthCalledWith(2, null);
    });

    it("should stay out of the user-placeable registry, so it needs no second switch", () => {
        // `birta.logseq` already decides whether the badge exists; a
        // `toolbar.items.logseq` placement would be a second switch for the
        // same question. Keeping it out of TOOLBAR_ITEM_IDS is also what keeps
        // toolbarDefaultsContributions.test.ts satisfied without one.
        expect(TOOLBAR_ITEM_IDS as readonly string[]).not.toContain("logseq");
    });
});
