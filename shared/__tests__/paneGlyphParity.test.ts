/**
 * The Mac titlebar's file-explorer toggle against the page's pane icon.
 *
 * They are one mark and its mirror: the page draws the outline panel's toggle
 * (`IconPanelLeft`, flipped by CSS for a right-hand dock) and the app draws the
 * explorer's at the other end of the same titlebar band
 * (`mac/Sources/BirtaWriter/PaneGlyph.swift`). Swift cannot import the page's
 * icon module, so the geometry is a port, and a port with no comparison is a
 * copy that goes stale the first time the SVG is tuned. Neither half looks
 * wrong on its own, which is why nothing else would report it.
 *
 * Both files are read as TEXT. Importing the page's icon would give the SVG
 * and still leave Swift unread, so the comparison has to be a parse either
 * way, and a parse that found nothing is the failure mode this asserts against
 * before it asserts anything else.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const iconsSource = readFileSync(resolve(root, "webview/ui/icons.ts"), "utf8");
const swiftSource = readFileSync(resolve(root, "mac/Sources/BirtaWriter/PaneGlyph.swift"), "utf8");

/** The page's `IconPanelLeft` declaration, SVG body and all. */
function pageGlyph(): string {
    const line = iconsSource.split("\n").find((l) => l.startsWith("export const IconPanelLeft"));
    if (line === undefined) { throw new Error("IconPanelLeft is no longer declared in webview/ui/icons.ts"); }
    return line;
}

/** One `static let <name>: CGFloat = <number>` out of the Swift. */
function swiftNumber(name: string): number {
    const match = swiftSource.match(new RegExp(`static let ${name}: CGFloat = (-?[0-9.]+)`));
    if (!match?.[1]) { throw new Error(`PaneGlyph.${name} is no longer declared`); }
    return Number(match[1]);
}

describe("the Mac titlebar's pane glyph against the page's", () => {
    it("the two sources should still hold the declarations this compares", () => {
        // The instrument reached something. Every assertion below is a parse
        // of one of these two strings, so a rename that emptied either would
        // otherwise leave this file passing over nothing.
        expect(pageGlyph()).toContain("<rect");
        expect(swiftSource).toContain("enum PaneGlyph");
        expect(swiftSource.length).toBeGreaterThan(500);
    });

    it("the page's stroke attributes should be the numbers Swift draws with", () => {
        const attrs = iconsSource.match(/const attrs = `([^`]+)`/)?.[1];
        expect(attrs).toBeDefined();
        expect(attrs).toContain(`viewBox="0 0 ${swiftNumber("viewBox")} ${swiftNumber("viewBox")}"`);
        expect(attrs).toContain(`stroke-width="${swiftNumber("strokeWidth")}"`);
        expect(attrs).toContain(`width="${swiftNumber("drawnSize")}" height="${swiftNumber("drawnSize")}"`);
    });

    it("the page's frame and divider should be the numbers Swift draws with", () => {
        const inset = swiftNumber("frameInset");
        const side = swiftNumber("viewBox") - inset * 2;
        expect(pageGlyph()).toContain(
            `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${swiftNumber("cornerRadius")}"/>`,
        );
        expect(pageGlyph()).toContain(`<path d="M${swiftNumber("dividerX")} ${inset}v${side}"/>`);
    });

    it("the trailing mark should stay the page's, drawn by nothing here", () => {
        // The band's other pane toggle is the outline's, and it is the page's
        // own button mirrored in CSS for a right-hand dock. Swift drawing a
        // second copy of it would be a mark nothing asks for and a second
        // place the pair could stop being a reflection.
        // Asserted on the DECLARATION rather than on the word: this file's own
        // prose says why there is no trailing case, and a guard that banned
        // the word would be broken by the sentence explaining it.
        expect(swiftSource).toContain("static func image() -> NSImage");
        expect(swiftSource).not.toMatch(/case\s+trailing/);
        // ...and the page really is where the mirror happens, so the sentence
        // above is about this codebase rather than about an idea of it.
        const barCss = readFileSync(resolve(root, "webview/components/toolbar/toolbar.css"), "utf8");
        expect(barCss).toMatch(/body\.toc-right \.tb-toc-btn svg \{\s*transform: scaleX\(-1\);/);
    });
});
