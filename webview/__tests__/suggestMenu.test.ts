/**
 * suggestMenu tests: the frontmatter suggestion dropdown in both modes —
 * the "+" mode (filter input, async fmSuggestions reply, keyboard selection,
 * create row, escape/close behavior) and the chip-edit mode (menu anchored
 * under an existing chip, filtered by the chip's contenteditable text).
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { renderFrontmatterPanel } from "../components/frontmatter";
import { dispatchFmSuggestions } from "../components/frontmatter/suggestMenu";

const FM_LIST = "---\ntags:\n- one\n- two\n---\n";

function setupDom(): void {
    document.body.innerHTML = '<div id="container"><div id="editor"></div></div>';
}

/** Renders the panel and clicks the "+" chip button of the first list row. */
function openMenu(frontmatter: string = FM_LIST): void {
    renderFrontmatterPanel(frontmatter);
    const addBtn = document.querySelector(".fm-chip-add") as HTMLElement;
    expect(addBtn).not.toBeNull();
    addBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

function menuEl(): HTMLElement | null {
    return document.querySelector(".fm-suggest-menu");
}

function inputEl(): HTMLInputElement {
    return document.querySelector(".fm-suggest-input") as HTMLInputElement;
}

/** Visible non-create option texts, in DOM order. */
function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-item:not(.fm-suggest-create)"),
    ).map((li) => li.textContent ?? "");
}

function createRowEl(): HTMLElement | null {
    return document.querySelector(".fm-suggest-create");
}

function pressKey(key: string): void {
    inputEl().dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
}

function typeText(text: string): void {
    const input = inputEl();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Returns the frontmatter strings posted via frontmatterUpdate messages. */
function postedFrontmatters(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; frontmatter?: string })
        .filter((msg) => msg.type === "frontmatterUpdate")
        .map((msg) => msg.frontmatter!);
}

/** Returns the keys of posted requestFmSuggestions messages. */
function requestedKeys(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; key?: string })
        .filter((msg) => msg.type === "requestFmSuggestions")
        .map((msg) => msg.key!);
}

describe("fm suggest menu opening", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("clicking + should open the menu with the filter input focused", () => {
        openMenu();

        expect(menuEl()).not.toBeNull();
        expect(document.activeElement).toBe(inputEl());
    });

    it("opening the menu should request suggestions for the row's key", () => {
        openMenu();

        expect(requestedKeys()).toEqual(["tags"]);
    });

    it("before the reply arrives only the create row should render for typed text", () => {
        openMenu();

        expect(optionTexts()).toEqual([]);
        typeText("draft");
        expect(optionTexts()).toEqual([]);
        expect(createRowEl()?.textContent).toContain('"draft"');
    });
});

describe("fm suggest menu options", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("a suggestions reply should render options minus values already in the list", () => {
        openMenu();

        dispatchFmSuggestions("tags", ["one", "workspace-a", "two", "workspace-b"]);

        // "one" and "two" are already chips in this file → excluded
        expect(optionTexts()).toEqual(["workspace-a", "workspace-b"]);
    });

    it("typing should filter options case-insensitively", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["Alpha", "beta", "alphabet"]);

        typeText("ALPH");

        expect(optionTexts()).toEqual(["Alpha", "alphabet"]);
    });

    it("the create row should be hidden when the typed text exactly matches an option", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha"]);

        typeText("alpha");
        expect(createRowEl()).toBeNull();

        typeText("alp");
        expect(createRowEl()?.textContent).toContain('"alp"');
    });
});

describe("fm suggest menu selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("Enter on a highlighted option should add it and commit the new item line", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha", "beta"]);

        pressKey("ArrowDown"); // highlight "alpha"
        pressKey("Enter");

        expect(menuEl()).toBeNull();
        const committed = postedFrontmatters();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toBe("---\ntags:\n- one\n- two\n- alpha\n---\n");
    });

    it("ArrowUp from no highlight should wrap to the last row", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha", "beta"]);

        pressKey("ArrowUp"); // wraps to "beta"
        pressKey("Enter");

        expect(postedFrontmatters()[0]).toContain("- beta");
    });

    it("Enter with no highlight should create the typed value", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha"]);

        typeText("fresh-tag");
        pressKey("Enter");

        expect(menuEl()).toBeNull();
        expect(postedFrontmatters()[0]).toBe("---\ntags:\n- one\n- two\n- fresh-tag\n---\n");
    });

    it("clicking the create row should add the typed value", () => {
        openMenu();
        dispatchFmSuggestions("tags", []);

        typeText("clicked-tag");
        createRowEl()!.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        expect(menuEl()).toBeNull();
        expect(postedFrontmatters()[0]).toContain("- clicked-tag");
    });

    it("clicking an option should add that value", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["clicked-option"]);

        (document.querySelector(".fm-suggest-item") as HTMLElement).dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );

        expect(postedFrontmatters()[0]).toContain("- clicked-option");
    });

    it("Enter with no highlight and no typed text should keep the menu open", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha"]);

        pressKey("Enter");

        expect(menuEl()).not.toBeNull();
        expect(postedFrontmatters()).toEqual([]);
    });
});

describe("fm suggest menu closing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("Escape should close the menu without committing anything", () => {
        openMenu();
        dispatchFmSuggestions("tags", ["alpha"]);
        typeText("alp");

        pressKey("Escape");

        expect(menuEl()).toBeNull();
        expect(postedFrontmatters()).toEqual([]);
    });

    it("input blur should close the menu without committing anything", () => {
        openMenu();

        inputEl().dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
        expect(postedFrontmatters()).toEqual([]);
    });

    it("a reply arriving after close should not render options", () => {
        openMenu();
        pressKey("Escape");

        dispatchFmSuggestions("tags", ["late"]);

        expect(menuEl()).toBeNull();
        expect(document.querySelectorAll(".fm-suggest-item")).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Chip-edit mode: the same dropdown opened while an existing chip's
// contenteditable text is focused, filtered by the chip's current text.
// ---------------------------------------------------------------------------

const FM_RELATED = `---
title: Hello
related:
  [
    "/write/notion",
    "/write/anthropic",
  ]
---
`;

/** The chip-text span at `index` (document order across all list rows). */
function chipText(index = 0): HTMLElement {
    return document.querySelectorAll(".fm-chip-text")[index] as HTMLElement;
}

/** Focuses a chip's text span (jsdom cannot focus contenteditable natively). */
function focusChip(index = 0): HTMLElement {
    const el = chipText(index);
    el.dispatchEvent(new FocusEvent("focus"));
    return el;
}

/** Replaces the chip's text and fires the input event (simulates typing). */
function typeInChip(el: HTMLElement, value: string): void {
    el.textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Dispatches a keydown on the chip text and returns it (for defaultPrevented). */
function pressChipKey(el: HTMLElement, key: string): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
}

describe("fm chip edit suggestions — opening", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("focusing a chip should request suggestions for the entry's key", () => {
        renderFrontmatterPanel(FM_LIST);

        focusChip(0);

        expect(requestedKeys()).toEqual(["tags"]);
        expect(menuEl()).not.toBeNull();
        // Chip mode has no filter input of its own: the chip text is the query.
        expect(document.querySelector(".fm-suggest-input")).toBeNull();
    });

    it("a reply should render options filtered by the chip's current text", () => {
        renderFrontmatterPanel(FM_RELATED);
        focusChip(0); // "/write/notion"

        dispatchFmSuggestions("related", ["/write/notion-labs", "/write/skill-factory"]);

        expect(optionTexts()).toEqual(["/write/notion-labs"]);
    });

    it("typing should narrow the options to substring matches", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "");
        dispatchFmSuggestions("related", [
            "/write/skill-factory", "/write/other", "/write/anthropic",
        ]);
        // Empty query: everything except values already in the list.
        expect(optionTexts()).toEqual(["/write/skill-factory", "/write/other"]);

        typeInChip(chip, "/write/skill-fac");

        expect(optionTexts()).toEqual(["/write/skill-factory"]);
    });

    it("values already in the list and the exact current text should be excluded", () => {
        renderFrontmatterPanel(FM_LIST);
        const chip = focusChip(0); // "one"
        typeInChip(chip, "");
        dispatchFmSuggestions("tags", ["one", "two", "three"]);

        // "two" is another chip in this file → excluded. The edited chip's
        // OWN original value ("one") stays suggestible so the user can
        // complete back to it after narrowing the text (intentional change).
        expect(optionTexts()).toEqual(["one", "three"]);

        typeInChip(chip, "three");

        // Exactly what is already typed is pointless to suggest.
        expect(optionTexts()).toEqual([]);
    });

    it("no create row should render in chip mode", () => {
        renderFrontmatterPanel(FM_LIST);
        const chip = focusChip(0);
        dispatchFmSuggestions("tags", []);

        typeInChip(chip, "brand-new");

        expect(createRowEl()).toBeNull();
    });
});

describe("fm chip edit suggestions — keyboard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("ArrowDown + Enter should replace the chip value and commit only that item's line", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0); // "/write/notion"
        typeInChip(chip, "/write/skill-fac");
        dispatchFmSuggestions("related", ["/write/skill-factory"]);

        const arrow = pressChipKey(chip, "ArrowDown");
        pressChipKey(chip, "Enter");

        expect(arrow.defaultPrevented).toBe(true); // caret hijacked while options exist
        expect(menuEl()).toBeNull();
        const committed = postedFrontmatters();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toBe(
            '---\ntitle: Hello\nrelated:\n  [\n    "/write/skill-factory",\n    "/write/anthropic",\n  ]\n---\n',
        );
    });

    it("Enter with no highlight should commit the typed text", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "/write/custom");
        dispatchFmSuggestions("related", ["/write/skill-factory"]);

        pressChipKey(chip, "Enter");

        expect(menuEl()).toBeNull();
        const committed = postedFrontmatters();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toContain('"/write/custom",');
        expect(committed[0]).not.toContain("/write/skill-factory");
    });

    it("ArrowDown with no options should not hijack the caret", () => {
        renderFrontmatterPanel(FM_LIST);
        const chip = focusChip(0); // no reply yet → no options

        const ev = pressChipKey(chip, "ArrowDown");

        expect(ev.defaultPrevented).toBe(false);
    });

    it("Escape with the menu open should close it without reverting the text", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "/write/cu");
        dispatchFmSuggestions("related", ["/write/custom-thing"]);

        pressChipKey(chip, "Escape");

        expect(menuEl()).toBeNull();
        expect(chip.textContent).toBe("/write/cu"); // still editing, text kept
        expect(postedFrontmatters()).toEqual([]);
    });

    it("Escape with the menu closed should revert to the original value", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "/write/cu");
        pressChipKey(chip, "Escape"); // closes the menu only

        pressChipKey(chip, "Escape"); // existing behavior: revert

        expect(chip.textContent).toBe("/write/notion");
        expect(postedFrontmatters()).toEqual([]);
    });
});

describe("fm chip edit suggestions — mouse and blur", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setupDom();
    });

    it("option mousedown should prevent default and apply the value", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "");
        dispatchFmSuggestions("related", ["/write/picked"]);

        const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        (document.querySelector(".fm-suggest-item") as HTMLElement).dispatchEvent(ev);

        expect(ev.defaultPrevented).toBe(true); // keeps the chip from blurring first
        expect(menuEl()).toBeNull();
        const committed = postedFrontmatters();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toContain('"/write/picked",');
        expect(committed[0]).not.toContain("/write/notion");
    });

    it("chip blur should close the menu without committing unchanged text", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        dispatchFmSuggestions("related", ["/write/skill-factory"]);
        expect(menuEl()).not.toBeNull();

        chip.dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
        expect(postedFrontmatters()).toEqual([]);
    });

    it("chip blur with edited text should commit through the regular path", () => {
        renderFrontmatterPanel(FM_RELATED);
        const chip = focusChip(0);
        typeInChip(chip, "/write/renamed");

        chip.dispatchEvent(new FocusEvent("blur"));

        expect(menuEl()).toBeNull();
        const committed = postedFrontmatters();
        expect(committed).toHaveLength(1);
        expect(committed[0]).toContain('"/write/renamed",');
    });
});

describe("fm suggest menu across panel re-renders", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("re-rendering the panel should close the menu and a late pick should commit nothing", () => {
        // Regression: a revert (webview/messageHandlers.ts) re-renders the
        // panel while the "+" menu is open; the menu stayed anchored to a
        // detached button and a pick pushed into a stale entry.
        openMenu();

        renderFrontmatterPanel(FM_LIST); // external revert path

        expect(menuEl()).toBeNull();

        // A late fmSuggestions reply must not resurrect any options...
        dispatchFmSuggestions("tags", ["alpha"]);
        // ...and any row that somehow survived must not commit on pick.
        const row = document.querySelector(".fm-suggest-item") as HTMLElement | null;
        row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(postedFrontmatters()).toEqual([]);
        expect(document.querySelector(".fm-suggest-menu")).toBeNull();
    });

    it("re-rendering the panel should close an open chip-edit menu", () => {
        renderFrontmatterPanel(FM_LIST);
        const chip = document.querySelector(".fm-chip-text") as HTMLElement;
        chip.dispatchEvent(new FocusEvent("focus"));
        expect(menuEl()).not.toBeNull();

        renderFrontmatterPanel(FM_LIST);

        expect(menuEl()).toBeNull();
        dispatchFmSuggestions("tags", ["late"]);
        expect(document.querySelectorAll(".fm-suggest-item")).toHaveLength(0);
    });
});

describe("chip-edit suggestions — the edited chip's own value stays suggestible", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockVscodeApi.getState.mockReturnValue(null);
        setupDom();
    });

    it("narrowing a chip's text should still suggest completing back to its original value", () => {
        // Regression: the chip menu excluded ALL present values including the
        // edited chip's own, so "/write/skill-fac" showed no options even
        // though "/write/skill-factory" exists in the workspace.
        renderFrontmatterPanel("---\nrelated:\n  [\n    \"/write/notion\",\n    \"/write/skill-factory\",\n  ]\n---\n");
        const chips = document.querySelectorAll(".fm-chip-text");
        const chip = chips[1] as HTMLElement; // "/write/skill-factory"

        chip.dispatchEvent(new FocusEvent("focus"));
        chip.textContent = "/write/skill-fac";
        chip.dispatchEvent(new Event("input", { bubbles: true }));
        dispatchFmSuggestions("related", ["/write/skill-factory", "/write/notion", "/write/other"]);

        const options = optionTexts();
        expect(options).toContain("/write/skill-factory");
        // Other chips' values stay excluded.
        expect(options).not.toContain("/write/notion");
    });
});
