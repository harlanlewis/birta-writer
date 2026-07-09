/**
 * frontmatter component tests: flat/raw mode classification, lossless YAML
 * parsing/serialization, the panel collapse toggle, and the raw editor.
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
        window.__i18n = undefined;
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

    it("frontmatterExpanded: false should render a fresh open collapsed", () => {
        window.__i18n = { frontmatterExpanded: false } as unknown as typeof window.__i18n;
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        expect(panel.classList.contains("collapsed")).toBe(true);
        expect(panel.querySelector(".fm-toggle-btn")?.textContent).toContain("Show metadata");
    });

    it("a per-tab persisted state should win over the frontmatterExpanded setting", () => {
        window.__i18n = { frontmatterExpanded: false } as unknown as typeof window.__i18n;
        mockVscodeApi.getState.mockReturnValue({ fmCollapsed: false });
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        expect(panel.classList.contains("collapsed")).toBe(false);
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

    // Regression: the panel serializes `key:\n  [\n  ]` after the last item of
    // a flow-multi list is deleted; rejecting it here dropped the whole panel
    // to raw mode on the next render.
    it("an empty multi-line flow list should parse tabular and round-trip byte-exact", () => {
        const raw = "---\nk:\n  [\n  ]\n---\n";

        const entries = parseTabularFrontmatter(raw);

        expect(entries).not.toBeNull();
        expect(entries![0]!.list!.kind).toBe("flow-multi");
        expect(entries![0]!.list!.items).toEqual([]);
        expect(serializeFrontmatter(entries!, raw)).toBe(raw);
    });

    it("deleting the last flow-multi item should serialize a block that re-parses as tabular", () => {
        const raw = '---\nk:\n  [\n    "a",\n  ]\n---\n';
        const entries = parseTabularFrontmatter(raw)!;

        entries[0]!.list!.items = [];
        const out = serializeFrontmatter(entries, raw);

        expect(out).toBe("---\nk:\n  [\n  ]\n---\n");
        expect(parseTabularFrontmatter(out)).not.toBeNull();
    });

    it("adding an item to an empty flow-multi list should use the conventional indent and trailing comma", () => {
        const raw = "---\nk:\n  [\n  ]\n---\n";
        const entries = parseTabularFrontmatter(raw)!;

        entries[0]!.list!.items.push({ value: "b" });
        const out = serializeFrontmatter(entries, raw);

        expect(out).toBe('---\nk:\n  [\n    "b",\n  ]\n---\n');
    });
});

describe("list item serialization — YAML indicator first characters", () => {
    // Regression: a value starting with `-` was emitted unquoted, so a block
    // list item serialized as `- - x` — a nested sequence to real YAML parsers
    // and rejected by parseTabularFrontmatter (panel dropped to raw mode).
    const RISKY_VALUES = ["- x", "-", "? y"];

    it("adding indicator-first values to a block list should emit quoted items that re-parse to the same value", () => {
        const raw = "---\ntags:\n  - one\n---\n";
        const entries = parseTabularFrontmatter(raw)!;

        for (const value of RISKY_VALUES) { entries[0]!.list!.items.push({ value }); }
        const out = serializeFrontmatter(entries, raw);

        expect(out).toContain('  - "- x"');
        expect(out).toContain('  - "-"');
        expect(out).toContain('  - "? y"');
        const reparsed = parseTabularFrontmatter(out);
        expect(reparsed).not.toBeNull();
        expect(reparsed![0]!.list!.items.map((i) => i.value)).toEqual(["one", ...RISKY_VALUES]);
    });

    it("adding indicator-first values to an inline flow list should emit quoted items that re-parse to the same value", () => {
        const raw = "---\ntags: [one]\n---\n";
        const entries = parseTabularFrontmatter(raw)!;

        for (const value of RISKY_VALUES) { entries[0]!.list!.items.push({ value }); }
        const out = serializeFrontmatter(entries, raw);

        expect(out).toBe('---\ntags: [one, "- x", "-", "? y"]\n---\n');
        const reparsed = parseTabularFrontmatter(out);
        expect(reparsed).not.toBeNull();
        expect(reparsed![0]!.list!.items.map((i) => i.value)).toEqual(["one", ...RISKY_VALUES]);
    });

    it("adding indicator-first values to a multi-line flow list should emit quoted items that re-parse to the same value", () => {
        const raw = "---\ntags:\n  [\n    one,\n  ]\n---\n";
        const entries = parseTabularFrontmatter(raw)!;

        for (const value of RISKY_VALUES) { entries[0]!.list!.items.push({ value }); }
        const out = serializeFrontmatter(entries, raw);

        expect(out).toContain('    "- x",');
        expect(out).toContain('    "-",');
        expect(out).toContain('    "? y",');
        const reparsed = parseTabularFrontmatter(out);
        expect(reparsed).not.toBeNull();
        expect(reparsed![0]!.list!.items.map((i) => i.value)).toEqual(["one", ...RISKY_VALUES]);
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

    it("the add button should open the suggestion menu for its key without committing", () => {
        // Detailed menu behavior is covered in suggestMenu.test.ts; this only
        // checks the chip-row wiring (menu opens, right key, no new chip yet).
        renderFrontmatterPanel(FM_RICH);
        const addBtn = document.querySelectorAll(".fm-chip-add")[1] as HTMLElement; // related row

        addBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(document.querySelector(".fm-suggest-menu")).not.toBeNull();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledTimes(1);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "requestFmSuggestions",
            key: "related",
        });
        // No chip is added until a value is chosen from the menu (3 tags + 3 related + 2 keywords)
        expect(document.querySelectorAll(".fm-chip-text")).toHaveLength(8);
    });
});

/** Table rows of the rendered panel. */
function panelRows(): NodeListOf<HTMLTableRowElement> {
    return document.querySelectorAll<HTMLTableRowElement>(".frontmatter-table tr");
}

/** Dispatches an undo/redo chord keydown on the given element. */
function dispatchChord(target: Element, opts: { shift?: boolean } = {}): void {
    target.dispatchEvent(new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        shiftKey: opts.shift === true,
        bubbles: true,
        cancelable: true,
    }));
}

describe("frontmatter panel keyboard activation and ARIA", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        window.__i18n = undefined;
        setupDom();
    });

    it("a detail-0 click on the toggle should collapse and expand the panel", () => {
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        const toggle = panel.querySelector<HTMLButtonElement>(".fm-toggle-btn")!;

        // element.click() fires with detail 0 — the keyboard (Enter/Space) branch
        toggle.click();
        expect(panel.classList.contains("collapsed")).toBe(true);

        toggle.click();
        expect(panel.classList.contains("collapsed")).toBe(false);
    });

    it("toggling should flip aria-expanded on the toggle button", () => {
        renderFrontmatterPanel(FM);
        const toggle = document.querySelector<HTMLButtonElement>(".fm-toggle-btn")!;
        expect(toggle.getAttribute("aria-expanded")).toBe("true");

        toggle.click();

        expect(toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("the toggle should point aria-controls at the collapsible content", () => {
        renderFrontmatterPanel(FM);
        const toggle = document.querySelector(".fm-toggle-btn")!;

        const id = toggle.getAttribute("aria-controls")!;

        expect(id).toBeTruthy();
        expect(document.getElementById(id)?.classList.contains("frontmatter-table")).toBe(true);
    });

    it("the raw-mode toggle should point aria-controls at the raw editor", () => {
        renderFrontmatterPanel(FM_NESTED);
        const toggle = document.querySelector(".fm-toggle-btn")!;

        const id = toggle.getAttribute("aria-controls")!;

        expect(document.getElementById(id)?.classList.contains("fm-raw-editor")).toBe(true);
    });

    it("the trash button should be the first row cell with an aria-label naming the key", () => {
        renderFrontmatterPanel(FM);
        const row = panelRows()[0]!;

        const firstCell = row.firstElementChild!;

        expect(firstCell.className).toBe("fm-action");
        const btn = firstCell.querySelector(".fm-delete-btn")!;
        expect(btn.getAttribute("aria-label")).toContain('"title"');
        // The custom tooltip replaces the native title attribute
        expect(btn.getAttribute("title")).toBeNull();
    });

    it("a detail-0 click on the trash button should delete the row", () => {
        renderFrontmatterPanel(FM);

        document.querySelector<HTMLButtonElement>(".fm-delete-btn")!.click();

        expect(panelRows()).toHaveLength(2);
        expect(postedFrontmatters()).toEqual([
            "---\ndate: 2026-01-01\ndraft: true\n---\n",
        ]);
    });

    it("deleting a row should move focus to the row that took its index", () => {
        renderFrontmatterPanel(FM);

        document.querySelector<HTMLButtonElement>(".fm-delete-btn")!.click();

        const firstKey = panelRows()[0]!.querySelector(".fm-key")!;
        expect(document.activeElement).toBe(firstKey);
    });

    it("renaming a key should refresh the trash button's aria-label", () => {
        renderFrontmatterPanel(FM);
        const keyTd = document.querySelector<HTMLElement>(".fm-key")!;

        keyTd.textContent = "headline";
        keyTd.dispatchEvent(new Event("blur"));

        const btn = document.querySelector(".fm-delete-btn")!;
        expect(btn.getAttribute("aria-label")).toContain('"headline"');
    });

    it("editable cells should expose textbox semantics with names and placeholders", () => {
        renderFrontmatterPanel(FM);
        const row = panelRows()[0]!;

        const keyTd = row.querySelector(".fm-key")!;
        const valTd = row.querySelector(".fm-val")!;

        expect(keyTd.getAttribute("role")).toBe("textbox");
        expect(keyTd.getAttribute("aria-multiline")).toBe("false");
        expect(keyTd.getAttribute("aria-label")).toBe("Field name");
        expect(keyTd.getAttribute("aria-placeholder")).toBe("key");
        expect(valTd.getAttribute("role")).toBe("textbox");
        expect(valTd.getAttribute("aria-label")).toBe("title");
        expect(valTd.getAttribute("aria-placeholder")).toBe("value");
    });

    it("chip text and remove buttons should carry accessible names for their value", () => {
        renderFrontmatterPanel(FM_RICH);

        const chipText = document.querySelector(".fm-chip-text")!;
        const removeBtn = document.querySelector(".fm-chip-remove")!;

        expect(chipText.getAttribute("role")).toBe("textbox");
        expect(chipText.getAttribute("aria-label")).toBe("think");
        expect(removeBtn.getAttribute("aria-label")).toContain('"think"');
    });

    it("a detail-0 click on a chip remove button should delete the item", () => {
        renderFrontmatterPanel(FM_RICH);

        document.querySelectorAll<HTMLButtonElement>(".fm-chip-remove")[3]!.click();

        const posted = postedFrontmatters()[0]!;
        expect(posted).not.toContain("/write/notion");
        expect(posted).toContain('    "/write/anthropic",');
    });

    it("deleting the last field should keep the panel and post an empty frontmatter", () => {
        renderFrontmatterPanel("---\ntitle: Hello\n---\n");

        document.querySelector<HTMLButtonElement>(".fm-delete-btn")!.click();

        expect(document.getElementById("frontmatter-panel")).not.toBeNull();
        expect(panelRows()).toHaveLength(0);
        expect(postedFrontmatters()).toEqual([""]);
        // Focus falls back to the Add-field button so the keyboard flow survives
        expect(document.activeElement?.className).toBe("fm-add-btn");
    });
});

describe("frontmatter panel cell commit behavior", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("Enter in a value cell should commit in place without losing focus", () => {
        renderFrontmatterPanel(FM);
        const cell = panelRows()[2]!.querySelector<HTMLElement>(".fm-val")!;
        cell.focus();
        cell.textContent = "false";

        cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

        expect(postedFrontmatters()).toEqual([
            '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: false\n---\n',
        ]);
        expect(document.activeElement).toBe(cell);
    });

    it("a blur after an Enter commit should not post a duplicate update", () => {
        renderFrontmatterPanel(FM);
        const cell = panelRows()[2]!.querySelector<HTMLElement>(".fm-val")!;
        cell.focus();
        cell.textContent = "false";

        cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        cell.dispatchEvent(new Event("blur"));

        expect(postedFrontmatters()).toHaveLength(1);
    });
});

describe("frontmatter panel Tab navigation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    const tab = (el: Element, shift = false) =>
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true }));

    it("Tab from a key cell should move to the value cell of the same row", () => {
        renderFrontmatterPanel(FM);
        const row = panelRows()[1]!;
        const keyCell = row.querySelector<HTMLElement>(".fm-key")!;
        keyCell.focus();

        tab(keyCell);

        expect(document.activeElement).toBe(row.querySelector(".fm-val"));
    });

    it("Tab from a value cell should move to the next row's key cell", () => {
        renderFrontmatterPanel(FM);
        const valCell = panelRows()[1]!.querySelector<HTMLElement>(".fm-val")!;
        valCell.focus();

        tab(valCell);

        expect(document.activeElement).toBe(panelRows()[2]!.querySelector(".fm-key"));
    });

    it("Shift+Tab from a value cell should move back to its key cell, not add a row", () => {
        // The reported bug: Shift+Tab on a value cell (last row, empty value)
        // created a new metadata row instead of returning to the key cell.
        renderFrontmatterPanel(FM);
        const rowsBefore = panelRows().length;
        const lastRow = panelRows()[rowsBefore - 1]!;
        const valCell = lastRow.querySelector<HTMLElement>(".fm-val")!;
        valCell.focus();

        tab(valCell, true);

        expect(panelRows()).toHaveLength(rowsBefore);
        expect(document.activeElement).toBe(lastRow.querySelector(".fm-key"));
    });

    it("Shift+Tab from a key cell should move to the previous row's value cell", () => {
        renderFrontmatterPanel(FM);
        const keyCell = panelRows()[2]!.querySelector<HTMLElement>(".fm-key")!;
        keyCell.focus();

        tab(keyCell, true);

        expect(document.activeElement).toBe(panelRows()[1]!.querySelector(".fm-val"));
    });

    it("Tab from the last row's value cell should add a new row", () => {
        renderFrontmatterPanel(FM);
        const rowsBefore = panelRows().length;
        const valCell = panelRows()[rowsBefore - 1]!.querySelector<HTMLElement>(".fm-val")!;
        valCell.focus();

        tab(valCell);

        expect(panelRows()).toHaveLength(rowsBefore + 1);
    });
});

describe("frontmatter panel undo/redo", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    const FM_EDITED = '---\ntitle: "Hello"\ndate: 2026-01-01\ndraft: false\n---\n';

    /** Commits draft: true → false through the value cell and returns the cell. */
    function commitDraftEdit(): HTMLElement {
        const cell = panelRows()[2]!.querySelector<HTMLElement>(".fm-val")!;
        cell.textContent = "false";
        cell.dispatchEvent(new Event("blur"));
        return cell;
    }

    it("Cmd+Z after a committed edit should post the previous raw and restore the cell", () => {
        renderFrontmatterPanel(FM);
        const cell = commitDraftEdit();
        expect(postedFrontmatters()).toEqual([FM_EDITED]);

        dispatchChord(cell);

        expect(postedFrontmatters()).toEqual([FM_EDITED, FM]);
        expect(panelRows()[2]!.querySelector(".fm-val")!.textContent).toBe("true");
    });

    it("Cmd+Shift+Z after an undo should re-apply the edit", () => {
        renderFrontmatterPanel(FM);
        const cell = commitDraftEdit();
        dispatchChord(cell);

        dispatchChord(document.getElementById("frontmatter-panel")!, { shift: true });

        expect(postedFrontmatters()).toEqual([FM_EDITED, FM, FM_EDITED]);
        expect(panelRows()[2]!.querySelector(".fm-val")!.textContent).toBe("false");
    });

    it("Cmd+Z with uncommitted typing should revert the cell locally without posting", () => {
        renderFrontmatterPanel(FM);
        const cell = panelRows()[2]!.querySelector<HTMLElement>(".fm-val")!;
        cell.textContent = "maybe"; // typed, not committed

        dispatchChord(cell);

        expect(cell.textContent).toBe("true");
        expect(postedFrontmatters()).toEqual([]);
        expect(cell.isConnected).toBe(true); // no re-render happened
    });

    it("Cmd+Z after a row delete should restore the row", () => {
        renderFrontmatterPanel(FM);
        document.querySelector<HTMLButtonElement>(".fm-delete-btn")!.click();
        expect(panelRows()).toHaveLength(2);

        dispatchChord(document.getElementById("frontmatter-panel")!);

        expect(panelRows()).toHaveLength(3);
        expect(postedFrontmatters().at(-1)).toBe(FM);
        expect(panelRows()[0]!.querySelector(".fm-key")!.textContent).toBe("title");
    });

    it("Cmd+Z after deleting the last field should bring the table back", () => {
        renderFrontmatterPanel("---\ntitle: Hello\n---\n");
        document.querySelector<HTMLButtonElement>(".fm-delete-btn")!.click();
        expect(panelRows()).toHaveLength(0);

        dispatchChord(document.getElementById("frontmatter-panel")!);

        expect(panelRows()).toHaveLength(1);
        expect(postedFrontmatters()).toEqual(["", "---\ntitle: Hello\n---\n"]);
    });

    it("the panel should be focusable so a chord from blank panel space is not lost", () => {
        // A click on empty panel chrome must land focus on the panel itself
        // (tabIndex -1) rather than <body>, or the undo chord below never
        // reaches the panel-level listener. Regression guard for the
        // click-blank-space-then-Cmd+Z gap found in runtime testing.
        renderFrontmatterPanel(FM);
        const panel = document.getElementById("frontmatter-panel")!;
        expect(panel.tabIndex).toBe(-1);

        commitDraftEdit();
        expect(postedFrontmatters()).toEqual([FM_EDITED]);
        panel.focus();
        dispatchChord(panel);

        expect(postedFrontmatters().at(-1)).toBe(FM);
    });

    it("an external re-render should reset the undo history", () => {
        renderFrontmatterPanel(FM);
        commitDraftEdit();
        expect(postedFrontmatters()).toEqual([FM_EDITED]);

        renderFrontmatterPanel(FM_EDITED); // e.g. echo of an external update
        dispatchChord(document.getElementById("frontmatter-panel")!);

        // Nothing to undo: no additional frontmatterUpdate is posted
        expect(postedFrontmatters()).toEqual([FM_EDITED]);
    });

    it("a committed raw-editor edit should be undoable from the panel", () => {
        renderFrontmatterPanel(FM_NESTED);
        const ta = document.querySelector<HTMLTextAreaElement>(".fm-raw-editor")!;
        ta.value = "author:\n  name: Someone Else";
        ta.dispatchEvent(new Event("blur"));
        expect(postedFrontmatters()).toEqual([
            "---\nauthor:\n  name: Someone Else\n---\n",
        ]);

        dispatchChord(document.getElementById("frontmatter-panel")!);

        expect(postedFrontmatters().at(-1)).toBe(FM_NESTED);
        expect(document.querySelector<HTMLTextAreaElement>(".fm-raw-editor")!.value)
            .toBe("author:\n  name: Jane\n  email: jane@example.com");
    });
});

describe("frontmatter panel ghost row cleanup", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("a freshly added empty row should be removed once focus leaves it", () => {
        renderFrontmatterPanel(FM);
        document.querySelector<HTMLButtonElement>(".fm-add-btn")!.click();
        expect(panelRows()).toHaveLength(4);

        document.querySelector<HTMLButtonElement>(".fm-toggle-btn")!.focus();
        vi.runAllTimers();

        expect(panelRows()).toHaveLength(3);
        expect(postedFrontmatters()).toEqual([]); // nothing was ever committed
    });

    it("repeated Add field clicks should not accumulate ghost rows", () => {
        renderFrontmatterPanel(FM);
        const addBtn = document.querySelector<HTMLButtonElement>(".fm-add-btn")!;

        addBtn.click();
        addBtn.click();
        vi.runAllTimers();

        // The abandoned first ghost is gone; the freshly focused row survives
        expect(panelRows()).toHaveLength(4);
        expect(document.activeElement).toBe(panelRows()[3]!.querySelector(".fm-key"));
    });

    it("a new row with typed content should survive focus leaving it", () => {
        renderFrontmatterPanel(FM);
        document.querySelector<HTMLButtonElement>(".fm-add-btn")!.click();
        const keyTd = panelRows()[3]!.querySelector<HTMLElement>(".fm-key")!;
        keyTd.textContent = "layout";
        keyTd.dispatchEvent(new Event("blur")); // commits the key

        document.querySelector<HTMLButtonElement>(".fm-toggle-btn")!.focus();
        vi.runAllTimers();

        expect(panelRows()).toHaveLength(4);
        expect(panelRows()[3]!.querySelector(".fm-key")!.textContent).toBe("layout");
    });
});
