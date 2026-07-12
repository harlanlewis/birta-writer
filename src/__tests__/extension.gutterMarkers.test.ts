/**
 * The "Gutter Markers" palette command: a QuickPick of the three resting
 * modes — the current one annotated — whose pick persists the setting via
 * the scope-respecting write. The broadcast to open editors is the
 * config-change listener's job (covered by the webview handler tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { promptGutterMarkersMode } from "../extension";

const showQuickPick = vscode.window.showQuickPick as ReturnType<typeof vi.fn>;

function mockConfiguration(get?: (key: string, defaultValue?: unknown) => unknown) {
    const update = vi.fn();
    const cfg = {
        get: vi.fn(get ?? ((_key: string, defaultValue?: unknown) => defaultValue)),
        inspect: vi.fn(() => undefined),
        update,
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
    return { update };
}

describe("promptGutterMarkersMode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("picking a different mode should persist it to the winning scope", async () => {
        // Arrange: current = default (headings)
        const { update } = mockConfiguration();
        showQuickPick.mockResolvedValue({ mode: "all", label: "All" });

        // Act
        await promptGutterMarkersMode();

        // Assert
        expect(update).toHaveBeenCalledWith("gutterMarkers", "all", vscode.ConfigurationTarget.Global);
    });

    it("the current mode's row should be annotated as current", async () => {
        // Arrange
        mockConfiguration((key, d) => (key === "gutterMarkers" ? "none" : d));
        showQuickPick.mockResolvedValue(undefined);

        // Act
        await promptGutterMarkersMode();

        // Assert
        const items = showQuickPick.mock.calls[0]![0] as Array<{ mode: string; description: string }>;
        expect(items.map((i) => i.mode)).toEqual(["none", "headings", "all"]);
        expect(items.find((i) => i.mode === "none")!.description).toMatch(/current$/);
        expect(items.find((i) => i.mode === "headings")!.description).not.toMatch(/current$/);
    });

    it("picking the current mode should write nothing", async () => {
        // Arrange
        const { update } = mockConfiguration((key, d) => (key === "gutterMarkers" ? "all" : d));
        showQuickPick.mockResolvedValue({ mode: "all", label: "All" });

        // Act
        await promptGutterMarkersMode();

        // Assert
        expect(update).not.toHaveBeenCalled();
    });

    it("dismissing the picker should write nothing", async () => {
        // Arrange
        const { update } = mockConfiguration();
        showQuickPick.mockResolvedValue(undefined);

        // Act
        await promptGutterMarkersMode();

        // Assert
        expect(update).not.toHaveBeenCalled();
    });
});
