/**
 * suggestMenu tests: the frontmatter "+" dropdown that offers workspace-wide
 * values for the same list key (filter input, async fmSuggestions reply,
 * keyboard selection, create row, and escape/close behavior).
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
