/**
 * mermaidLoader tests: Mermaid is loaded via a cached dynamic import() so its
 * large bundle stays out of the launch path and every diagram in a document
 * shares one load. `mermaid` is mocked to keep the test fast and hermetic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("mermaid", () => ({
    default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg/>" })) },
}));

describe("loadMermaid", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("should resolve to the Mermaid module", async () => {
        // Arrange
        const { loadMermaid } = await import("../utils/mermaidLoader");
        // Act
        const mermaid = await loadMermaid();
        // Assert
        expect(typeof mermaid.render).toBe("function");
        expect(typeof mermaid.initialize).toBe("function");
    });

    it("should cache the load across calls (one shared promise)", async () => {
        // Arrange
        const { loadMermaid } = await import("../utils/mermaidLoader");
        // Act / Assert
        expect(loadMermaid()).toBe(loadMermaid());
    });
});
