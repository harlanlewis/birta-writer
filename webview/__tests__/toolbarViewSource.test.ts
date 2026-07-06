/**
 * Toolbar "Edit Raw Markdown" (viewSource) button: rendered by default in the
 * right zone, it hands off to the onSwitchToSource callback (which posts the
 * switchToTextEditor message with the first visible source line).
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { initToolbar } from "../components/toolbar";

function buildToolbar(onSwitchToSource?: () => void): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(
        topbar,
        () => null,
        undefined,
        undefined,
        undefined,
        undefined,
        onSwitchToSource,
    );
    return topbar;
}

function findViewSourceItem(topbar: HTMLElement): HTMLElement | null {
    return topbar.querySelector<HTMLElement>('.tb-item[data-item-id="viewSource"]');
}

describe("toolbar viewSource button", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("with a callback should render the button in the right zone by default", () => {
        // Arrange / Act
        const topbar = buildToolbar(() => {});

        // Assert
        const item = findViewSourceItem(topbar);
        expect(item).not.toBeNull();
        expect(item!.closest(".tb-zone--right")).not.toBeNull();
    });

    it("a mousedown on the button should invoke the switch callback", () => {
        // Arrange
        const onSwitch = vi.fn();
        const topbar = buildToolbar(onSwitch);
        const button = findViewSourceItem(topbar)!.querySelector("button")!;

        // Act
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        // Assert
        expect(onSwitch).toHaveBeenCalledTimes(1);
    });

    it("without a callback should not render the button", () => {
        // Arrange / Act
        const topbar = buildToolbar(undefined);

        // Assert
        expect(findViewSourceItem(topbar)).toBeNull();
    });
});
