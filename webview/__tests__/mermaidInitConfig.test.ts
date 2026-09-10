/**
 * What the runtime hands `mermaid.initialize()`.
 *
 * `layout` and `look` are Mermaid-wide defaults, so an upgrade can move them,
 * and moving either redraws every diagram in every document a user already
 * has. The pin in `mermaidRuntime.ts` is what stops that; this is what stops
 * the pin being deleted, since nothing else in the suite reads the config
 * (`mermaidBlock.test.ts` stubs `initialize` to a no-op).
 *
 * The assertion drives the real exported path rather than reading the source,
 * so it holds against the value that actually reaches Mermaid.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const initialize = vi.fn();

vi.mock("mermaid", () => ({
    default: {
        initialize,
        render: vi.fn(async () => ({ svg: '<svg viewBox="0 0 100 50"></svg>' })),
    },
}));

async function initConfig(): Promise<Record<string, unknown>> {
    const { renderMermaidToSvg } = await import("../components/codeBlock/mermaidRuntime");
    await renderMermaidToSvg("graph TD; A-->B;", 600);
    // The probe is worthless if it never reached initialize, and an empty
    // config object reads exactly like a missing key, so fail loudly here
    // rather than let every expectation below report a false negative.
    expect(initialize).toHaveBeenCalledTimes(1);
    return initialize.mock.calls[0][0] as Record<string, unknown>;
}

describe("mermaid.initialize config", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it("a diagram render should pin the layout engine to dagre", async () => {
        // Arrange / Act
        const config = await initConfig();
        // Assert
        expect(config.layout).toBe("dagre");
    });

    it("a diagram render should pin the shape vocabulary to the classic look", async () => {
        // Arrange / Act
        const config = await initConfig();
        // Assert
        expect(config.look).toBe("classic");
    });

    it("a diagram render should pin the label wrapping width", async () => {
        // Arrange / Act
        const config = await initConfig();
        // Assert: flowchart.wrappingWidth decides how wide a node label grows
        // before it wraps, so it sets every labelled node's size and through
        // them the whole diagram's. Mermaid 12 moved this default from 200 to
        // 120, which redrew flowcharts that nobody had edited.
        expect((config.flowchart as Record<string, unknown>).wrappingWidth).toBe(200);
    });

    it("the pinned defaults should sit beside the settings the runtime already fixed", async () => {
        // Arrange / Act
        const config = await initConfig();
        // Assert: the pin is additive, so the surrounding contract still holds.
        expect(config.startOnLoad).toBe(false);
        expect(config.securityLevel).toBe("strict");
        expect(config.theme).toMatch(/^(default|dark)$/);
    });
});
