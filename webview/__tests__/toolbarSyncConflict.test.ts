/**
 * Toolbar disk-drift badge: hidden by default, pinned (non-draggable) at the
 * front of the right zone, shown/hidden by the extension's syncConflict
 * messages, and clicking it asks the extension for the reload/compare picker.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initToolbar } from "../components/toolbar";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
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
    return topbar.querySelector<HTMLElement>('.tb-item[data-item-id="syncConflict"]');
}

describe("toolbar disk-drift badge", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("should render hidden by default, pinned at the front of the right zone", () => {
        const { topbar } = buildToolbar();

        const item = findBadgeItem(topbar);
        expect(item).not.toBeNull();
        expect(item!.style.display).toBe("none");
        const rightZone = topbar.querySelector(".tb-zone--right")!;
        expect(rightZone.firstElementChild).toBe(item);
    });

    it("setSyncConflict(true) should show the badge; (false) should hide it again", () => {
        const { topbar, controller } = buildToolbar();
        const item = findBadgeItem(topbar)!;

        controller.setSyncConflict(true);
        expect(item.style.display).toBe("");
        controller.setSyncConflict(false);
        expect(item.style.display).toBe("none");
    });

    it("the drift state should also toggle the body class that tints the hidden-toolbar tab", () => {
        // With the toolbar hidden the badge can't render; the body class lets the
        // collapsed bar's expand tab carry the warning color instead.
        const { controller } = buildToolbar();

        controller.setSyncConflict(true);
        expect(document.body.classList.contains("has-sync-conflict")).toBe(true);
        controller.setSyncConflict(false);
        expect(document.body.classList.contains("has-sync-conflict")).toBe(false);
    });

    it("clicking the visible badge should post resolveSyncConflict to the extension", () => {
        const { topbar, controller } = buildToolbar();
        controller.setSyncConflict(true);
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "resolveSyncConflict" });
    });

    it("a syncConflict message should drive the toolbar controller's badge state", () => {
        const setSyncConflict = vi.fn();
        const deps = {
            state: {} as MessageHandlerDeps["state"],
            actions: {} as MessageHandlerDeps["actions"],
            topbarTb: { setSyncConflict } as unknown as MessageHandlerDeps["topbarTb"],
        } as MessageHandlerDeps;
        const handlers = createMessageHandlers(deps);
        const container = document.createElement("div");

        handlers.syncConflict?.({ type: "syncConflict", state: "conflict" }, container);
        handlers.syncConflict?.({ type: "syncConflict", state: "none" }, container);

        expect(setSyncConflict).toHaveBeenNthCalledWith(1, true);
        expect(setSyncConflict).toHaveBeenNthCalledWith(2, false);
    });
});
