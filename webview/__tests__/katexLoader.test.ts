/**
 * katexLoader tests: the KaTeX stylesheet is emitted as its own esbuild entry
 * (dist/katex.css) and injected lazily via a <link> the first time math loads,
 * instead of being statically bundled into the render-blocking entry CSS. These
 * tests pin that injection behavior (once, correct href) and that rendering
 * still flows through the loaded module. `katex` is mocked so the tests stay
 * fast and hermetic; module state is reset per test so the injection guard and
 * cached promise start fresh.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("katex", () => ({
    default: { render: vi.fn((latex: string, el: HTMLElement) => { el.textContent = `[rendered:${latex}]`; }) },
}));

describe("katexLoader", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        document.head.querySelectorAll("link[data-katex-css]").forEach((l) => l.remove());
    });

    it("loading KaTeX should inject the stylesheet link exactly once", async () => {
        // Arrange
        const { loadKatex } = await import("../utils/katexLoader");
        // Act: load twice (every math node shares the loader)
        await loadKatex();
        await loadKatex();
        // Assert
        const links = document.head.querySelectorAll("link[data-katex-css]");
        expect(links.length).toBe(1);
    });

    it("the injected link should point at the sibling katex.css", async () => {
        // Arrange
        const { loadKatex } = await import("../utils/katexLoader");
        // Act
        await loadKatex();
        // Assert: resolved relative to the bundle (import.meta.url), so it ends in katex.css
        const link = document.head.querySelector<HTMLLinkElement>("link[data-katex-css]");
        expect(link?.getAttribute("href")).toMatch(/\/katex\.css$/);
        expect(link?.rel).toBe("stylesheet");
    });

    it("rendering math should paint through the loaded module and inject the stylesheet", async () => {
        // Arrange
        const { renderKatexInto } = await import("../utils/katexLoader");
        const target = document.createElement("span");
        // Act
        await renderKatexInto(target, "a^2", false);
        // Assert
        expect(target.textContent).toBe("[rendered:a^2]");
        expect(document.head.querySelectorAll("link[data-katex-css]").length).toBe(1);
    });
});
