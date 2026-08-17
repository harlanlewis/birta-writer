/**
 * plantUmlLoader tests: the PlantUML engine is loaded through a cached dynamic
 * import(), and the Graphviz engine it bridges to is loaded only when a render
 * actually reaches the bridge (MAR-369). The compiled engine and the Graphviz
 * loader are both mocked: what is under test is the wiring between them, not
 * either engine.
 *
 * The mock engine models the one property the loader depends on: `convert()`
 * is synchronous and calls `globalThis.__graphviz_anywhere_render` mid-render
 * for the families Graphviz lays out, and never touches it for the others.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const BRIDGE_KEY = "__graphviz_anywhere_render";
type Bridge = (dot: string, engine: string, format: string) => string;

/** How the mock engine renders. Set per test before calling convert(). */
let renderMode: "native" | "graphviz" | "graphviz-swallow" | "invalid" = "native";
const glueConvert = vi.fn((source: string): string => {
    if (renderMode === "invalid") throw new Error("Unsupported diagram type: unknown");
    if (renderMode === "graphviz" || renderMode === "graphviz-swallow") {
        const bridge = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as Bridge;
        try {
            return `<svg>${bridge(`digraph { ${source} }`, "dot", "svg")}</svg>`;
        } catch (err) {
            // A compiled engine that turns a failed layout into a placeholder
            // rather than an error is the case "graphviz-swallow" models.
            if (renderMode === "graphviz-swallow") return "<svg>placeholder</svg>";
            throw err;
        }
    }
    return `<svg>${source}</svg>`;
});

vi.mock("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.js", () => ({
    convert: (source: string) => glueConvert(source),
    version: () => "test",
    __wbg_set_wasm: vi.fn(),
}));
vi.mock("@kookyleo/plantuml-little-web/dist/wasm/plantuml_little_web_bg.wasm", () => ({
    default: new Uint8Array(0),
}));

const layout = vi.fn((dot: string, format: string, engine: string) => `laid-out:${engine}:${format}:${dot}`);
let graphvizEngine: { layout: typeof layout } | null = null;
const loadGraphviz = vi.fn(async () => {
    graphvizEngine = { layout };
    return graphvizEngine;
});
vi.mock("../utils/graphvizLoader", () => ({
    loadGraphviz: () => loadGraphviz(),
    peekGraphviz: () => graphvizEngine,
}));

async function freshLoader() {
    vi.resetModules();
    return import("../utils/plantUmlLoader");
}

describe("loadPlantUml", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        renderMode = "native";
        graphvizEngine = null;
        vi.stubGlobal("WebAssembly", {
            instantiate: vi.fn(async () => ({ instance: { exports: {} } })),
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        delete (globalThis as Record<string, unknown>)[BRIDGE_KEY];
    });

    it("should install the bridge without loading Graphviz", async () => {
        // Arrange
        const { loadPlantUml } = await freshLoader();
        // Act
        await loadPlantUml();
        // Assert
        expect(typeof (globalThis as Record<string, unknown>)[BRIDGE_KEY]).toBe("function");
        expect(loadGraphviz).not.toHaveBeenCalled();
    });

    it("should cache the load across calls (one shared promise)", async () => {
        // Arrange
        const { loadPlantUml } = await freshLoader();
        // Act
        const first = loadPlantUml();
        const second = loadPlantUml();
        await first;
        // Assert
        expect(first).toBe(second);
    });

    it("a natively laid-out diagram should render without Graphviz ever loading", async () => {
        // Arrange
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act
        const svg = await engine.convert("Alice -> Bob");
        // Assert
        expect(svg).toBe("<svg>Alice -> Bob</svg>");
        expect(loadGraphviz).not.toHaveBeenCalled();
        expect(glueConvert).toHaveBeenCalledTimes(1);
    });

    it("a Graphviz-laid-out diagram should load Graphviz on first need and re-render the same source", async () => {
        // Arrange
        renderMode = "graphviz";
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act
        const svg = await engine.convert("class Foo");
        // Assert
        expect(loadGraphviz).toHaveBeenCalledTimes(1);
        // First attempt reached the bridge with no engine and failed fast; the
        // retry went through the loaded engine with the argument order swapped
        // into the loader's (dot, format, engine).
        expect(glueConvert).toHaveBeenCalledTimes(2);
        expect(glueConvert.mock.calls.map(([s]) => s)).toEqual(["class Foo", "class Foo"]);
        expect(layout).toHaveBeenCalledTimes(1);
        expect(svg).toBe("<svg>laid-out:dot:svg:digraph { class Foo }</svg>");
    });

    it("a first attempt that reached the bridge should be discarded even if the engine returned markup", async () => {
        // Arrange
        renderMode = "graphviz-swallow";
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act
        const svg = await engine.convert("class Foo");
        // Assert
        expect(loadGraphviz).toHaveBeenCalledTimes(1);
        expect(svg).toBe("<svg>laid-out:dot:svg:digraph { class Foo }</svg>");
    });

    it("once Graphviz is loaded, a Graphviz-laid-out diagram should render in one attempt", async () => {
        // Arrange
        renderMode = "graphviz";
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        await engine.convert("class Foo");
        glueConvert.mockClear();
        loadGraphviz.mockClear();
        // Act
        await engine.convert("class Bar");
        // Assert
        expect(glueConvert).toHaveBeenCalledTimes(1);
        expect(loadGraphviz).not.toHaveBeenCalled();
    });

    it("an engine already loaded by a graphviz fence should be used without a failed first attempt", async () => {
        // Arrange
        renderMode = "graphviz";
        graphvizEngine = { layout };
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act
        await engine.convert("class Foo");
        // Assert
        expect(glueConvert).toHaveBeenCalledTimes(1);
        expect(loadGraphviz).not.toHaveBeenCalled();
    });

    it("an invalid diagram should reject with the engine's own error and not load Graphviz", async () => {
        // Arrange
        renderMode = "invalid";
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act / Assert
        await expect(engine.convert("!!!")).rejects.toThrow("Unsupported diagram type: unknown");
        expect(loadGraphviz).not.toHaveBeenCalled();
        expect(glueConvert).toHaveBeenCalledTimes(1);
    });

    it("a Graphviz load failure should reject the render and be retried by the next one", async () => {
        // Arrange
        renderMode = "graphviz";
        loadGraphviz.mockRejectedValueOnce(new Error("chunk failed"));
        const { loadPlantUml } = await freshLoader();
        const engine = await loadPlantUml();
        // Act / Assert
        await expect(engine.convert("class Foo")).rejects.toThrow("chunk failed");
        await expect(engine.convert("class Foo")).resolves.toContain("laid-out");
        expect(loadGraphviz).toHaveBeenCalledTimes(2);
    });

    it("a failed engine load should not be cached", async () => {
        // Arrange
        const { loadPlantUml } = await freshLoader();
        const instantiate = (globalThis.WebAssembly as unknown as { instantiate: ReturnType<typeof vi.fn> }).instantiate;
        instantiate.mockRejectedValueOnce(new Error("bad wasm"));
        // Act / Assert
        await expect(loadPlantUml()).rejects.toThrow("bad wasm");
        await expect(loadPlantUml()).resolves.toBeDefined();
    });
});
