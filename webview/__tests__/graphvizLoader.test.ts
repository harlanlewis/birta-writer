/**
 * graphvizLoader tests: one cached engine shared by ```graphviz fences and the
 * PlantUML bridge, plus the synchronous peek the bridge relies on (MAR-369).
 * `@hpcc-js/wasm-graphviz` is mocked to keep the test fast and hermetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const load = vi.fn(async () => ({
    layout: vi.fn((dot: string, format: string, engine: string) => `${engine}:${format}:${dot}`),
}));
vi.mock("@hpcc-js/wasm-graphviz", () => ({ Graphviz: { load: () => load() } }));

async function freshLoader() {
    vi.resetModules();
    return import("../utils/graphvizLoader");
}

describe("loadGraphviz", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("should cache the load across calls (one shared promise, one instantiation)", async () => {
        // Arrange
        const { loadGraphviz } = await freshLoader();
        // Act
        const first = loadGraphviz();
        const second = loadGraphviz();
        await first;
        // Assert
        expect(first).toBe(second);
        expect(load).toHaveBeenCalledTimes(1);
    });

    it("should hand layout arguments through in (dot, format, engine) order", async () => {
        // Arrange
        const { loadGraphviz } = await freshLoader();
        const engine = await loadGraphviz();
        // Act / Assert
        expect(engine.layout("digraph {}", "svg", "dot")).toBe("dot:svg:digraph {}");
    });

    it("peekGraphviz should be null before a load and never start one", async () => {
        // Arrange
        const { peekGraphviz } = await freshLoader();
        // Act / Assert
        expect(peekGraphviz()).toBeNull();
        expect(load).not.toHaveBeenCalled();
    });

    it("peekGraphviz should return the same engine the load resolved to", async () => {
        // Arrange
        const { loadGraphviz, peekGraphviz } = await freshLoader();
        // Act
        const engine = await loadGraphviz();
        // Assert
        expect(peekGraphviz()).toBe(engine);
    });

    it("a failed load should not be cached, and peekGraphviz should stay null", async () => {
        // Arrange
        load.mockRejectedValueOnce(new Error("chunk failed"));
        const { loadGraphviz, peekGraphviz } = await freshLoader();
        // Act / Assert
        await expect(loadGraphviz()).rejects.toThrow("chunk failed");
        expect(peekGraphviz()).toBeNull();
        await expect(loadGraphviz()).resolves.toBeDefined();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("resetGraphvizEngineForTests should forget the engine for peek and load alike", async () => {
        // Arrange
        const { loadGraphviz, peekGraphviz, resetGraphvizEngineForTests } = await freshLoader();
        await loadGraphviz();
        // Act
        resetGraphvizEngineForTests();
        // Assert
        expect(peekGraphviz()).toBeNull();
        await loadGraphviz();
        expect(load).toHaveBeenCalledTimes(2);
    });
});
