/**
 * frontmatter component tests: YAML parsing/serialization and the panel collapse toggle.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    parseFrontmatter,
    serializeFrontmatter,
    renderFrontmatterPanel,
} from "../components/frontmatter";

const FM = '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: true\n---\n';

function setupDom(): void {
    document.body.innerHTML = '<div id="container"><div id="editor"></div></div>';
}

describe("parseFrontmatter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("standard frontmatter should parse into key-value entries", () => {
        const entries = parseFrontmatter(FM);
        expect(entries).toEqual([
            { key: "title", value: '"Hello"' },
            { key: "date", value: "2026-01-01" },
            { key: "draft", value: "true" },
        ]);
    });

    it("lines without a colon should be ignored", () => {
        const entries = parseFrontmatter("---\nno colon here\nkey: value\n---\n");
        expect(entries).toEqual([{ key: "key", value: "value" }]);
    });
});

describe("serializeFrontmatter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("entries should serialize back to a fenced YAML block", () => {
        const raw = serializeFrontmatter([
            { key: "title", value: '"Hello"' },
            { key: "draft", value: "true" },
        ]);
        expect(raw).toBe('---\ntitle: "Hello"\ndraft: true\n---\n');
    });

    it("an empty entry list should serialize to an empty string", () => {
        expect(serializeFrontmatter([])).toBe("");
    });
});

describe("renderFrontmatterPanel collapse toggle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("a file with frontmatter should render the panel expanded by default", () => {
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel");
        expect(panel).toBeTruthy();
        expect(panel!.classList.contains("collapsed")).toBe(false);
        expect(panel!.querySelectorAll(".frontmatter-table tr")).toHaveLength(3);
        const toggle = panel!.querySelector(".fm-toggle-btn");
        expect(toggle?.textContent).toContain("Hide metadata");
        // The toggle sits immediately to the left of the Add-field button
        expect(toggle?.nextElementSibling?.className).toBe("fm-add-btn");
    });

    it("clicking the toggle should collapse the panel and persist the state", () => {
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        const btn = panel.querySelector(".fm-toggle-btn")!;

        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(panel.classList.contains("collapsed")).toBe(true);
        expect(btn.textContent).toContain("Show metadata");
        expect(mockVscodeApi.setState).toHaveBeenCalledWith(
            expect.objectContaining({ fmCollapsed: true }),
        );
    });

    it("clicking the toggle twice should expand the panel again", () => {
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        const btn = panel.querySelector(".fm-toggle-btn")!;

        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(panel.classList.contains("collapsed")).toBe(false);
        expect(mockVscodeApi.setState).toHaveBeenLastCalledWith(
            expect.objectContaining({ fmCollapsed: false }),
        );
    });

    it("a persisted collapsed state should render the panel collapsed", () => {
        mockVscodeApi.getState.mockReturnValue({ fmCollapsed: true });
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        expect(panel.classList.contains("collapsed")).toBe(true);
    });

    it("persisting the collapsed state should not clobber other webview state keys", () => {
        mockVscodeApi.getState.mockReturnValue({ scrollY: 120 });
        renderFrontmatterPanel(FM);
        const btn = document.querySelector(".fm-toggle-btn")!;

        btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        expect(mockVscodeApi.setState).toHaveBeenCalledWith({ scrollY: 120, fmCollapsed: true });
    });

    it("undefined frontmatter should remove the panel", () => {
        renderFrontmatterPanel(FM);
        renderFrontmatterPanel(undefined);
        expect(document.getElementById("frontmatter-panel")).toBeNull();
    });
});
