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
    parseTabularFrontmatter,
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

    // Intentional behavior change: simple lists were originally routed to the
    // raw editor as an interim safety measure; they now get the table with
    // lossless chip-list editing (see the "tabular list editing" suites).
    it("simple list frontmatter should render the table with a chip list, not the raw editor", () => {
        renderFrontmatterPanel(FM_LIST);
        expect(document.querySelector(".fm-raw-editor")).toBeNull();
        const chips = document.querySelectorAll(".fm-chip .fm-chip-text");
        expect(Array.from(chips).map((c) => c.textContent)).toEqual(["one", "two"]);
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

describe("renderFrontmatterPanel raw mode CRLF handling", () => {
    const FM_CRLF = "---\r\nauthor:\r\n  name: Jane\r\n---\r\n";

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

    it("blurring a CRLF block without edits should not post a phantom commit", () => {
        renderFrontmatterPanel(FM_CRLF);
        const ta = getRawEditor();
        // Browsers normalize the textarea API value to LF; simulate that explicitly
        // so the test holds regardless of jsdom's normalization behavior.
        ta.value = ta.value.replace(/\r\n/g, "\n");

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([]);
    });

    it("a real edit to a CRLF block should commit with CRLF restored throughout", () => {
        renderFrontmatterPanel(FM_CRLF);
        const ta = getRawEditor();
        // The browser hands back LF-normalized content after the user edits.
        ta.value = "author:\n  name: Jane\n  url: https://example.com";

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([
            "---\r\nauthor:\r\n  name: Jane\r\n  url: https://example.com\r\n---\r\n",
        ]);
    });

    it("a CRLF block with a single inner line should commit CRLF throughout after an edit", () => {
        // The inner text of a one-line CRLF block contains no \r\n itself, so
        // deriving the EOL style from the inner (instead of the full raw block
        // with its CRLF fences) used to commit LF lines between CRLF fences.
        renderFrontmatterPanel("---\r\ntitle: a\r\n---\r\n");
        const ta = getRawEditor();
        // The browser hands back LF-normalized content after the user edits.
        ta.value = "title: a\nsubtitle: b";

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([
            "---\r\ntitle: a\r\nsubtitle: b\r\n---\r\n",
        ]);
    });

    it("Escape should revert a CRLF block without producing a phantom commit", () => {
        renderFrontmatterPanel(FM_CRLF);
        const ta = getRawEditor();
        ta.value = "author:\n  name: Someone Else";

        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([]);
        expect(ta.value.replace(/\r\n/g, "\n")).toBe("author:\n  name: Jane");
    });
});

describe("renderFrontmatterPanel raw mode fence-line rejection", () => {
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

    // The extension re-extracts frontmatter with a first-`---` regex, so an inner
    // fence-like line would truncate the block and corrupt the document later.
    it("an inner line of only --- should refuse the commit and mark the textarea invalid", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        const bad = "author:\n  name: Jane\n---\nextra: line";
        ta.value = bad;

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([]);
        expect(ta.getAttribute("aria-invalid")).toBe("true");
        expect(ta.title).not.toBe("");
        expect(ta.value).toBe(bad); // user content is kept, not reverted
    });

    it("an inner YAML document-end line (...) should also refuse the commit", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        ta.value = "author:\n  name: Jane\n...";

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([]);
        expect(ta.getAttribute("aria-invalid")).toBe("true");
    });

    // Fence-PREFIXED lines are rejected too: extraction regexes (current and
    // historical) and third-party frontmatter parsers can treat a line that
    // merely starts with the marker as a closing fence, truncating the file.
    it.each([
        ["--- draft"],
        ["----"],
        ["--- "],
        ["... done"],
    ])("an inner line starting with a fence marker (%j) should refuse the commit", (badLine) => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        const bad = `author:\n  name: Jane\n${badLine}\nextra: line`;
        ta.value = bad;

        ta.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toEqual([]);
        expect(ta.getAttribute("aria-invalid")).toBe("true");
        expect(ta.value).toBe(bad); // user content is kept, not reverted
    });

    it("a line merely containing --- after other text should still commit", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        ta.value = "author:\n  name: Jane\nnote: a --- b";

        ta.dispatchEvent(new Event("blur"));

        expect(ta.getAttribute("aria-invalid")).toBeNull();
        expect(postedFrontmatters()).toEqual([
            "---\nauthor:\n  name: Jane\nnote: a --- b\n---\n",
        ]);
    });

    it("fixing the offending line should clear the invalid state and commit", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = getRawEditor();
        ta.value = "author:\n  name: Jane\n---";
        ta.dispatchEvent(new Event("blur"));
        expect(postedFrontmatters()).toEqual([]);

        ta.value = "author:\n  name: Jane\nextra: line";
        ta.dispatchEvent(new Event("blur"));

        expect(ta.getAttribute("aria-invalid")).toBeNull();
        expect(postedFrontmatters()).toEqual([
            "---\nauthor:\n  name: Jane\nextra: line\n---\n",
        ]);
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

// A realistic rich-metadata block mirroring the field report that motivated
// list support: scalars + inline flow + two multi-line flow sequences with
// quoted items and trailing commas on every line.
const FM_RICH = `---
title: "The AI Playbook"
date: 2026-06-29T18:00:00-07:00
tags: ["think", "playbook", "ai"]
draft: true
related:
  [
    "/write/notion",
    "/write/anthropic",
    "/write/shopify",
  ]
keywords:
  [
    "enablement",
    "internal AI",
  ]
---
`;

const FM_BLOCK_LIST = `---
title: Hello
tags:
  - one
  - two words
---
`;

describe("parseTabularFrontmatter", () => {
    it("a rich block with inline and multi-line flow lists should parse into entries", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;

        expect(entries.map((e) => e.key)).toEqual([
            "title", "date", "tags", "draft", "related", "keywords",
        ]);
        expect(entries[2]!.list!.kind).toBe("flow-inline");
        expect(entries[2]!.list!.items.map((i) => i.value)).toEqual(["think", "playbook", "ai"]);
        expect(entries[4]!.list!.kind).toBe("flow-multi");
        expect(entries[4]!.list!.items.map((i) => i.value)).toEqual([
            "/write/notion", "/write/anthropic", "/write/shopify",
        ]);
    });

    it("a block list should parse with its indentation and unquoted style", () => {
        const entries = parseTabularFrontmatter(FM_BLOCK_LIST)!;

        expect(entries[1]!.list!.kind).toBe("block");
        expect(entries[1]!.list!.items.map((i) => i.value)).toEqual(["one", "two words"]);
        expect(entries[1]!.list!.itemIndent).toBe("  ");
    });

    it("nested maps, comments and colon-less lines should not be tabular", () => {
        expect(parseTabularFrontmatter("---\nauthor:\n  name: Jane\n---\n")).toBeNull();
        expect(parseTabularFrontmatter("---\n# comment\na: 1\n---\n")).toBeNull();
        expect(parseTabularFrontmatter("---\nno colon\n---\n")).toBeNull();
    });

    it("a nested flow sequence should not be tabular", () => {
        expect(parseTabularFrontmatter("---\nmatrix: [[1, 2], [3, 4]]\n---\n")).toBeNull();
    });
});

describe("tabular list editing — lossless serialization", () => {
    it("an unedited rich block should round-trip byte-for-byte", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        expect(serializeFrontmatter(entries, FM_RICH)).toBe(FM_RICH);
    });

    it("editing a scalar should leave every list line byte-identical", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        entries[0]!.value = '"New Title"';

        const out = serializeFrontmatter(entries, FM_RICH);

        expect(out).toContain('title: "New Title"');
        for (const line of FM_RICH.split("\n").slice(2, -2)) {
            expect(out).toContain(line);
        }
    });

    it("editing one list item should rewrite only that item's line, preserving its quote style", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        entries[4]!.list!.items[1]!.value = "/write/renamed";

        const out = serializeFrontmatter(entries, FM_RICH);

        expect(out).toContain('    "/write/renamed",');
        expect(out).not.toContain("/write/anthropic");
        expect(out).toContain('    "/write/notion",');
        expect(out).toContain('    "/write/shopify",');
        expect(out).toContain('tags: ["think", "playbook", "ai"]');
    });

    it("removing a list item should delete exactly its line", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        entries[4]!.list!.items.splice(1, 1);

        const out = serializeFrontmatter(entries, FM_RICH);

        expect(out).not.toContain("/write/anthropic");
        expect(out).toContain('    "/write/notion",');
        expect(out).toContain('    "/write/shopify",');
    });

    it("adding an item to a trailing-comma list should match the existing style", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        entries[5]!.list!.items.push({ value: "new keyword" });

        const out = serializeFrontmatter(entries, FM_RICH);

        expect(out).toContain('    "new keyword",');
        expect(out).toContain('    "enablement",');
    });

    it("adding an item to a comma-except-last list should re-comma the old last item", () => {
        const raw = '---\nrel:\n  [\n    "a",\n    "b"\n  ]\n---\n';
        const entries = parseTabularFrontmatter(raw)!;
        entries[0]!.list!.items.push({ value: "c" });

        const out = serializeFrontmatter(entries, raw);

        expect(out).toBe('---\nrel:\n  [\n    "a",\n    "b",\n    "c"\n  ]\n---\n');
    });

    it("editing an inline flow list should rebuild only that line", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        entries[2]!.list!.items.push({ value: "essay" });

        const out = serializeFrontmatter(entries, FM_RICH);

        expect(out).toContain('tags: ["think", "playbook", "ai", "essay"]');
        expect(out).toContain('    "/write/notion",');
    });

    it("editing a block-list item should keep the dash style and indentation", () => {
        const entries = parseTabularFrontmatter(FM_BLOCK_LIST)!;
        entries[1]!.list!.items[0]!.value = "renamed";

        const out = serializeFrontmatter(entries, FM_BLOCK_LIST);

        expect(out).toBe("---\ntitle: Hello\ntags:\n  - renamed\n  - two words\n---\n");
    });

    it("deleting a list-valued key should remove its whole span", () => {
        const entries = parseTabularFrontmatter(FM_RICH)!;
        const filtered = entries.filter((e) => e.key !== "related");

        const out = serializeFrontmatter(filtered, FM_RICH);

        expect(out).not.toContain("related");
        expect(out).not.toContain("/write/notion");
        expect(out).toContain('tags: ["think", "playbook", "ai"]');
        expect(out).toContain('    "enablement",');
    });
});

describe("tabular list editing — chip UI", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("a rich block should render chips for each list item", () => {
        renderFrontmatterPanel(FM_RICH);

        expect(document.querySelector(".fm-raw-editor")).toBeNull();
        const rows = document.querySelectorAll(".frontmatter-table tr");
        expect(rows.length).toBe(6);
        const relatedChips = rows[4]!.querySelectorAll(".fm-chip-text");
        expect(Array.from(relatedChips).map((c) => c.textContent)).toEqual([
            "/write/notion", "/write/anthropic", "/write/shopify",
        ]);
    });

    it("editing a chip should commit a block where only that item's line changed", () => {
        renderFrontmatterPanel(FM_RICH);
        const chip = document.querySelectorAll(".fm-chip-text")[3] as HTMLElement; // first related item

        chip.textContent = "/write/renamed";
        chip.dispatchEvent(new FocusEvent("blur"));

        expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(1);
        const posted = mockVscodeApi.postMessage.mock.calls[0]![0].frontmatter as string;
        expect(posted).toContain('    "/write/renamed",');
        expect(posted).not.toContain("/write/notion");
        expect(posted).toContain('    "/write/anthropic",');
    });

    it("the chip remove button should commit a block without that item", () => {
        renderFrontmatterPanel(FM_RICH);
        const removeBtn = document.querySelectorAll(".fm-chip-remove")[3] as HTMLElement;

        removeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const posted = mockVscodeApi.postMessage.mock.calls[0]![0].frontmatter as string;
        expect(posted).not.toContain("/write/notion");
        expect(posted).toContain('    "/write/anthropic",');
    });

    it("blurring a new empty chip should discard it without committing", () => {
        renderFrontmatterPanel(FM_RICH);
        const addBtn = document.querySelectorAll(".fm-chip-add")[1] as HTMLElement; // related row

        addBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        const newChip = document.querySelectorAll(".fm-chip-text")[6] as HTMLElement;
        newChip.dispatchEvent(new FocusEvent("blur"));

        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });
});
