/**
 * Toolbar disk-conflict badge: hidden by default, pinned (non-draggable) at the
 * front of the right zone, shown/hidden by the extension's syncConflict
 * messages, and clicking it asks the extension for the resolution picker.
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

describe("toolbar sync-conflict badge", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("should render hidden by default, pinned at the front of the right zone", () => {
        // Arrange / Act
        const { topbar } = buildToolbar();

        // Assert
        const item = findBadgeItem(topbar);
        expect(item).not.toBeNull();
        expect(item!.style.display).toBe("none");
        const rightZone = topbar.querySelector(".tb-zone--right")!;
        expect(rightZone.firstElementChild).toBe(item);
    });

    it("setSyncConflict(true) should show the badge; (false) should hide it again", () => {
        // Arrange
        const { topbar, controller } = buildToolbar();
        const item = findBadgeItem(topbar)!;

        // Act / Assert
        controller.setSyncConflict(true);
        expect(item.style.display).toBe("");
        controller.setSyncConflict(false);
        expect(item.style.display).toBe("none");
    });

    it("clicking the visible badge should post resolveSyncConflict to the extension", () => {
        // Arrange
        const { topbar, controller } = buildToolbar();
        controller.setSyncConflict(true);
        const button = findBadgeItem(topbar)!.querySelector("button")!;

        // Act
        button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        // Assert
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "resolveSyncConflict" });
    });

    it("a syncConflict message should drive the toolbar controller's badge state", () => {
        // Arrange
        const setSyncConflict = vi.fn();
        const deps = {
            state: {} as MessageHandlerDeps["state"],
            actions: {} as MessageHandlerDeps["actions"],
            topbarTb: { setSyncConflict } as unknown as MessageHandlerDeps["topbarTb"],
        } as MessageHandlerDeps;
        const handlers = createMessageHandlers(deps);
        const container = document.createElement("div");

        // Act
        handlers.syncConflict?.({ type: "syncConflict", state: "conflict" }, container);
        handlers.syncConflict?.({ type: "syncConflict", state: "none" }, container);

        // Assert
        expect(setSyncConflict).toHaveBeenNthCalledWith(1, true);
        expect(setSyncConflict).toHaveBeenNthCalledWith(2, false);
    });
});
