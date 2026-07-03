/**
 * frontmatter component tests: flat/raw mode classification, lossless YAML
 * parsing/serialization, the panel collapse toggle, and the raw editor.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    isFlatFrontmatter,
    parseFrontmatter,
    serializeFrontmatter,
    renderFrontmatterPanel,
} from "../components/frontmatter";

const FM = '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: true\n---\n';
const FM_NESTED = "---\nauthor:\n  name: Jane\n  email: jane@example.com\n---\n";
const FM_LIST = "---\ntags:\n- one\n- two\n---\n";
const FM_COMMENT = "---\n# site metadata\ntitle: Hello\n---\n";
const FM_BLOCK_SCALAR = "---\ndescription: |\n  line one\n  line two\n---\n";
const FM_NO_COLON = "---\nno colon here\nkey: value\n---\n";

function setupDom(): void {
    document.body.innerHTML = '<div id="container"><div id="editor"></div></div>';
}

/** Returns the frontmatter strings posted via frontmatterUpdate messages. */
function postedFrontmatters(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; frontmatter?: string })
        .filter((msg) => msg.type === "frontmatterUpdate")
        .map((msg) => msg.frontmatter!);
}

describe("isFlatFrontmatter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("plain key-value frontmatter should be classified as flat", () => {
        expect(isFlatFrontmatter(FM)).toBe(true);
    });

    it("a blank inner line should not prevent the flat classification", () => {
        expect(isFlatFrontmatter("---\ntitle: Hello\n\ndraft: true\n---\n")).toBe(true);
    });

    it("a nested map should not be flat", () => {
        expect(isFlatFrontmatter(FM_NESTED)).toBe(false);
    });

    it("a YAML list should not be flat", () => {
        expect(isFlatFrontmatter(FM_LIST)).toBe(false);
    });

    it("a comment line should not be flat", () => {
        expect(isFlatFrontmatter(FM_COMMENT)).toBe(false);
    });

    it("a block scalar indicator should not be flat", () => {
        expect(isFlatFrontmatter(FM_BLOCK_SCALAR)).toBe(false);
        expect(isFlatFrontmatter("---\nsummary: >\n  folded\n---\n")).toBe(false);
    });

    it("a colon-less line should not be flat", () => {
        expect(isFlatFrontmatter(FM_NO_COLON)).toBe(false);
    });

    it("anchors, aliases and flow collections should not be flat", () => {
        expect(isFlatFrontmatter("---\nbase: &anchor value\n---\n")).toBe(false);
        expect(isFlatFrontmatter("---\ncopy: *anchor\n---\n")).toBe(false);
        expect(isFlatFrontmatter("---\ntags: [a, b]\n---\n")).toBe(false);
    });

    it("a trailing comment on a value should not be flat", () => {
        expect(isFlatFrontmatter("---\ntitle: Hello # comment\n---\n")).toBe(false);
    });

    it("an unterminated quoted value should not be flat", () => {
        expect(isFlatFrontmatter('---\ntitle: "multi\n---\n')).toBe(false);
    });

    it("CRLF line endings should route to raw mode", () => {
        expect(isFlatFrontmatter('---\r\ntitle: Hello\r\n---\r\n')).toBe(false);
    });
});

describe("parseFrontmatter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    // Entries now carry origLine so serialization can preserve untouched lines
    // byte-for-byte (MAR-6 lossless fix).
    it("standard frontmatter should parse into key-value entries with original lines", () => {
        const entries = parseFrontmatter(FM);
        expect(entries).toEqual([
            { key: "title", value: '"Hello"', origLine: 'title: "Hello"' },
            { key: "date", value: "2026-01-01", origLine: "date: 2026-01-01" },
            { key: "draft", value: "true", origLine: "draft: true" },
        ]);
    });

    // The old behavior of silently dropping colon-less lines was destructive at
    // the UI level; such blocks are now routed to raw mode by isFlatFrontmatter,
    // so parseFrontmatter only ever receives flat blocks. The parse-level filter
    // is kept as a defensive fallback and asserted here.
    it("lines without a colon should be excluded from entries (block itself goes to raw mode)", () => {
        expect(isFlatFrontmatter(FM_NO_COLON)).toBe(false);
        const entries = parseFrontmatter(FM_NO_COLON);
        expect(entries).toEqual([{ key: "key", value: "value", origLine: "key: value" }]);
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

    it("unchanged entries with the original raw should round-trip byte-for-byte", () => {
        const entries = parseFrontmatter(FM);
        expect(serializeFrontmatter(entries, FM)).toBe(FM);
    });

    it("editing one value should leave all other lines byte-identical", () => {
        const entries = parseFrontmatter(FM);
        entries[1]!.value = "2027-12-31";
        expect(serializeFrontmatter(entries, FM)).toBe(
            '---\ntitle: "Hello"\ndate: 2027-12-31\ndraft: true\n---\n',
        );
    });

    it("editing a value should preserve the original colon spacing style", () => {
        const raw = "---\ntitle:   spaced\ncount: 2\n---\n";
        const entries = parseFrontmatter(raw);
        entries[0]!.value = "changed";
        expect(serializeFrontmatter(entries, raw)).toBe(
            "---\ntitle:   changed\ncount: 2\n---\n",
        );
    });

    it("blank lines in the original block should be preserved on edit", () => {
        const raw = "---\ntitle: Hello\n\ndraft: true\n---\n";
        const entries = parseFrontmatter(raw);
        entries[1]!.value = "false";
        expect(serializeFrontmatter(entries, raw)).toBe(
            "---\ntitle: Hello\n\ndraft: false\n---\n",
        );
    });

    it("deleting an entry should remove only its line", () => {
        const entries = parseFrontmatter(FM);
        entries.splice(1, 1);
        expect(serializeFrontmatter(entries, FM)).toBe(
            '---\ntitle: "Hello"\ndraft: true\n---\n',
        );
    });

    it("a new entry should be appended before the closing fence", () => {
        const entries = parseFrontmatter(FM);
        entries.push({ key: "layout", value: "post" });
        expect(serializeFrontmatter(entries, FM)).toBe(
            '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: true\nlayout: post\n---\n',
        );
    });
});

describe("renderFrontmatterPanel raw mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    function getRawEditor(): HTMLTextAreaElement {
        const ta = document.querySelector<HTMLTextAreaElement>(".fm-raw-editor");
        expect(ta).toBeTruthy();
        return ta!;
    }

    it("nested map frontmatter should render the raw editor instead of the table", () => {
        renderFrontmatterPanel(FM_NESTED);
        const panel = document.getElementById("frontmatter-panel")!;
        expect(panel.querySelector(".frontmatter-table")).toBeNull();
        expect(panel.querySelector(".fm-add-btn")).toBeNull();
        expect(getRawEditor().value).toBe("author:\n  name: Jane\n  email: jane@example.com");
    });

    it("list frontmatter should render the raw editor", () => {
        renderFrontmatterPanel(FM_LIST);
        expect(document.querySelector(".frontmatter-table")).toBeNull();
        expect(getRawEditor().value).toBe("tags:\n- one\n- two");
    });

    it("comment lines should render the raw editor with the comment intact", () => {
        renderFrontmatterPanel(FM_COMMENT);
        expect(getRawEditor().value).toBe("# site metadata\ntitle: Hello");
    });

    it("a colon-less line should render the raw editor and not be dropped", () => {
        renderFrontmatterPanel(FM_NO_COLON);
        expect(getRawEditor().value).toBe("no colon here\nkey: value");
    });

    it("blurring without changes should not post any frontmatter update", () => {
        renderFrontmatterPanel(FM_NESTED);
        getRawEditor().dispatchEvent(new Event("blur"));
        expect(postedFrontmatters()).toEqual([]);
    });

    it("committing an edit should write the textarea content verbatim between the original fences", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        ta.value = "author:\n  name: Jane\n  email: jane@example.com\n  url: https://example.com";
        ta.dispatchEvent(new Event("blur"));
        expect(postedFrontmatters()).toEqual([
            "---\nauthor:\n  name: Jane\n  email: jane@example.com\n  url: https://example.com\n---\n",
        ]);
    });

    it("the raw panel should still show the collapse toggle", () => {
        renderFrontmatterPanel(FM_NESTED);
        const toggle = document.querySelector(".fm-toggle-btn");
        expect(toggle?.textContent).toContain("Hide metadata");
    });
});

describe("renderFrontmatterPanel flat mode editing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("editing one value cell should leave the other lines byte-identical", () => {
        renderFrontmatterPanel(FM);
        const rows = document.querySelectorAll(".frontmatter-table tr");
        const draftVal = rows[2]!.querySelector<HTMLElement>(".fm-val")!;

        draftVal.textContent = "false";
        draftVal.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([
            '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: false\n---\n',
        ]);
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
