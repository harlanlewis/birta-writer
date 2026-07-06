/**
 * The native-theme bridge turns VS Code's live <body> theme-class swaps into the
 * "theme-changed" event that JS-driven consumers (e.g. Mermaid re-rendering)
 * listen for, so they refresh even in auto mode where the extension pushes no
 * setTheme message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { themeKindFromClass, observeNativeThemeChanges } from "../nativeThemeBridge";

describe("themeKindFromClass", () => {
    it("a dark body class should be reported as vscode-dark", () => {
        expect(themeKindFromClass("vscode-dark")).toBe("vscode-dark");
    });

    it("high-contrast-light should win over the shorter high-contrast match", () => {
        expect(themeKindFromClass("vscode-high-contrast-light")).toBe("vscode-high-contrast-light");
    });

    it("theme class among unrelated classes should still be detected", () => {
        expect(themeKindFromClass("foo vscode-light bar")).toBe("vscode-light");
    });

    it("no theme class should return an empty string", () => {
        expect(themeKindFromClass("foo bar")).toBe("");
    });
});

describe("observeNativeThemeChanges", () => {
    let body: HTMLElement;
    let target: EventTarget;
    let onThemeChanged: ReturnType<typeof vi.fn>;
    let dispose: () => void;

    beforeEach(() => {
        body = document.createElement("body");
        body.className = "vscode-dark";
        target = new EventTarget();
        onThemeChanged = vi.fn();
        target.addEventListener("theme-changed", onThemeChanged);
        dispose = observeNativeThemeChanges(body, target);
    });

    afterEach(() => {
        dispose();
    });

    // The bridge defers the dispatch to the next animation frame; wait long
    // enough for that (or its setTimeout fallback) to run.
    const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

    it("changing the theme kind should dispatch theme-changed", async () => {
        body.className = "vscode-light";
        await flush();
        expect(onThemeChanged).toHaveBeenCalledTimes(1);
    });

    it("high-contrast dark -> high-contrast light should dispatch (ordered discriminator)", async () => {
        // VS Code sets `vscode-high-contrast-light` ALONGSIDE `vscode-high-contrast`,
        // so this transition only registers if the most-specific class wins.
        body.className = "vscode-high-contrast";
        await flush();
        expect(onThemeChanged).toHaveBeenCalledTimes(1); // dark -> hc

        body.className = "vscode-high-contrast vscode-high-contrast-light";
        await flush();
        expect(onThemeChanged).toHaveBeenCalledTimes(2); // hc -> hc-light
    });

    it("an unrelated class change should not dispatch theme-changed", async () => {
        body.className = "vscode-dark some-other-class";
        await flush();
        expect(onThemeChanged).not.toHaveBeenCalled();
    });

    it("disposing should stop further dispatches", async () => {
        dispose();
        body.className = "vscode-light";
        await flush();
        expect(onThemeChanged).not.toHaveBeenCalled();
    });
});
