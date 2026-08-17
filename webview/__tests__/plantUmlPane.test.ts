/**
 * Reading a PlantUML diagram's natural size out of its own markup.
 *
 * The shared diagram pane scales the SVG with a CSS transform against a FIXED
 * pixel size, so a wrong natural size does not merely mis-fit — it makes
 * fit-to-view and the adaptive container height compute against the container
 * instead, which is the bug class MAR-205 covers on the Mermaid side. Mermaid
 * measures off-screen; PlantUML states its size, so the parse is the measurement
 * and is worth pinning directly.
 */
import { describe, it, expect } from "vitest";
import { readSvgNaturalSize } from "../components/codeBlock/plantUmlPane";

describe("readSvgNaturalSize", () => {
    it("explicit width/height attributes should be used as the natural size", () => {
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 320, height: 180 });
    });

    it("px-suffixed dimensions should parse to their numeric value", () => {
        const svg = '<svg width="320px" height="180px"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 320, height: 180 });
    });

    it("pt-suffixed dimensions, which is what Graphviz emits, should scale to CSS pixels", () => {
        // 1pt = 96/72 px. Reading the bare number paints a DOT graph at three
        // quarters of its size; the viewBox is in the same units, so it is no
        // safety net here.
        const svg = '<svg width="72pt" height="144pt" viewBox="0.00 0.00 72.00 144.00"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 96, height: 192 });
    });

    it("an unknown length unit should fall back to the viewBox rather than guess", () => {
        const svg = '<svg width="10em" height="5em" viewBox="0 0 640 480"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 640, height: 480 });
    });

    it("a percentage width should fall back to the viewBox rather than be treated as pixels", () => {
        // A container-relative width is not a natural size; using it would make
        // the CSS scale base on the container and mis-size the diagram.
        const svg = '<svg width="100%" height="100%" viewBox="0 0 640 480"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 640, height: 480 });
    });

    it("missing dimensions should fall back to the viewBox", () => {
        const svg = '<svg viewBox="0 0 500 250"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 500, height: 250 });
    });

    it("a comma-separated viewBox should parse the same as a space-separated one", () => {
        expect(readSvgNaturalSize('<svg viewBox="0,0,500,250"></svg>'))
            .toEqual({ width: 500, height: 250 });
    });

    it("markup with no usable dimensions at all should fall back to a fixed size", () => {
        const size = readSvgNaturalSize("<svg></svg>");
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
    });

    it("markup that is not an SVG should fall back rather than throw", () => {
        expect(() => readSvgNaturalSize("not markup at all")).not.toThrow();
        const size = readSvgNaturalSize("not markup at all");
        expect(size.width).toBeGreaterThan(0);
    });

    it("a zero or negative dimension should be rejected in favour of the viewBox", () => {
        const svg = '<svg width="0" height="0" viewBox="0 0 100 50"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 100, height: 50 });
    });

    it("the real engine's XML preamble before the svg tag should not confuse the parse", () => {
        // plantuml-little prefixes its output with a `<?plantuml …?>` PI.
        const svg = '<?plantuml 1.2026.2?><svg xmlns="http://www.w3.org/2000/svg" width="212" height="128"></svg>';
        expect(readSvgNaturalSize(svg)).toEqual({ width: 212, height: 128 });
    });
});
