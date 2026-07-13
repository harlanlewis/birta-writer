/**
 * The "Gutter Markers" palette command: a createQuickPick of the three
 * resting modes — the current one annotated AND preselected (so Enter
 * straight after opening is a no-op, never an accidental switch) — whose
 * accept persists the setting via the scope-respecting write. The broadcast
 * to open editors is the config-change listener's job (covered by the
 * webview handler tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

import { promptGutterMarkersMode } from "../extension";

const createQuickPick = vscode.window.createQuickPick as ReturnType<typeof vi.fn>;

type FakeQuickPick = {
    items: Array<{ mode: string; label: string; description: string }>;
    activeItems: Array<{ mode: string }>;
    selectedItems: Array<{ mode: string }>;
    onDidAccept: ReturnType<typeof vi.fn>;
    onDidHide: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
};

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

/** Start the prompt and hand back the live fake QuickPick plus the promise. */
function openPrompt(): { qp: FakeQuickPick; done: Promise<void> } {
    const done = promptGutterMarkersMode();
    const qp = createQuickPick.mock.results.at(-1)!.value as FakeQuickPick;
    return { qp, done };
}

const accept = (qp: FakeQuickPick, mode: string): void => {
    qp.selectedItems = [qp.items.find((i) => i.mode === mode)!];
    (qp.onDidAccept.mock.calls[0]![0] as () => void)();
};

const dismiss = (qp: FakeQuickPick): void => {
    (qp.onDidHide.mock.calls[0]![0] as () => void)();
};

describe("promptGutterMarkersMode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("accepting a different mode should persist it to the winning scope", async () => {
        // Arrange: current = default (headings)
        const { update } = mockConfiguration();

        // Act
        const { qp, done } = openPrompt();
        accept(qp, "all");
        await done;

        // Assert
        expect(update).toHaveBeenCalledWith("gutterMarkers", "all", vscode.ConfigurationTarget.Global);
    });

    it("the current mode should be annotated and preselected, in display order", async () => {
        // Arrange
        mockConfiguration((key, d) => (key === "gutterMarkers" ? "none" : d));

        // Act
        const { qp, done } = openPrompt();
        dismiss(qp);
        await done;

        // Assert
        expect(qp.show).toHaveBeenCalled();
        expect(qp.items.map((i) => i.mode)).toEqual(["none", "headings", "all"]);
        expect(qp.items.find((i) => i.mode === "none")!.description).toMatch(/current$/);
        expect(qp.items.find((i) => i.mode === "headings")!.description).not.toMatch(/current$/);
        // Preselection is what makes Enter-on-open a no-op.
        expect(qp.activeItems.map((i) => i.mode)).toEqual(["none"]);
    });

    it("accepting the current mode should write nothing", async () => {
        // Arrange
        const { update } = mockConfiguration((key, d) => (key === "gutterMarkers" ? "all" : d));

        // Act
        const { qp, done } = openPrompt();
        accept(qp, "all");
        await done;

        // Assert
        expect(update).not.toHaveBeenCalled();
    });

    it("dismissing the picker should write nothing", async () => {
        // Arrange
        const { update } = mockConfiguration();

        // Act
        const { qp, done } = openPrompt();
        dismiss(qp);
        await done;

        // Assert
        expect(update).not.toHaveBeenCalled();
    });
});
