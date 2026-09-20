/**
 * contentWidthBoot.test.ts — the document's width state is put on the page at
 * boot, both halves, for every host.
 *
 * The two halves are `--editor-max-width` and the `editor-width-auto` class,
 * and style.css reads the class to pick which margin rules apply and the
 * variable inside them. The fixed set reads the variable with NO fallback, so
 * a page that carries the class-off half without the variable loses
 * `margin-left` entirely (invalid at computed-value time) and draws the
 * document under a docked drawer. jsdom has no cascade to measure that in, so
 * what is asserted here is the pair; e2e/fileExplorer measures where the
 * content actually lands.
 *
 * The host that matters is one declaring `contentMeasure` and carrying no
 * width style of its own, which is the Mac app: VS Code writes both halves
 * into the served HTML, so a page-side failure is invisible there.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyBootContentWidth, bootContentWidthMode } from "../contentWidth";

type I18n = typeof window.__i18n;

function setHost(capabilities: string[], extra: Record<string, unknown> = {}): void {
    window.__i18n = {
        translations: {},
        host: { capabilities, arrangements: [], shortcuts: [] },
        ...extra,
    } as unknown as I18n;
}

describe("applyBootContentWidth", () => {
    beforeEach(() => {
        document.body.className = "";
        document.documentElement.style.removeProperty("--editor-max-width");
    });
    afterEach(() => {
        delete (window as { __i18n?: I18n }).__i18n;
    });

    it("a host declaring contentMeasure and full width should get the class and no cap", () => {
        setHost(["contentMeasure"], { contentWidth: "full" });
        applyBootContentWidth();
        expect(document.body.classList.contains("editor-width-auto")).toBe(true);
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toBe("none");
    });

    it("a host declaring contentMeasure and fixed width should get the cap and no class", () => {
        setHost(["contentMeasure"], { contentWidth: "fixed", maxContentWidth: 72 });
        applyBootContentWidth();
        expect(document.body.classList.contains("editor-width-auto")).toBe(false);
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toBe("72ch");
    });

    it("a fixed host with no stored measure should still write a length, never an empty cap", () => {
        setHost(["contentMeasure"], { contentWidth: "fixed" });
        applyBootContentWidth();
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toMatch(/^\d+ch$/);
    });

    it("a stored fixed width on a host with no measure to change it should resolve to full", () => {
        setHost([], { contentWidth: "fixed", maxContentWidth: 72 });
        expect(bootContentWidthMode()).toBe("full");
        applyBootContentWidth();
        expect(document.body.classList.contains("editor-width-auto")).toBe(true);
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toBe("none");
    });

    it("a page declaring nothing at all should get the full-width default", () => {
        delete (window as { __i18n?: I18n }).__i18n;
        applyBootContentWidth();
        expect(document.body.classList.contains("editor-width-auto")).toBe(true);
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toBe("none");
    });

    it("an unknown stored mode should fall back rather than leave the cap unwritten", () => {
        setHost(["contentMeasure"], { contentWidth: "wide" });
        applyBootContentWidth();
        expect(document.body.classList.contains("editor-width-auto")).toBe(true);
        expect(document.documentElement.style.getPropertyValue("--editor-max-width")).toBe("none");
    });
});
