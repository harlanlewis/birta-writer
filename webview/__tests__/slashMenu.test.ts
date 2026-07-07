/**
 * Component tests for the slash-menu dropdown DOM (createSlashMenu):
 * rendering, filtering, highlight tracking, picking, and aria wiring —
 * driven purely through synthetic DOM events (suggestMenu.test.ts pattern).
 * The ProseMirror side is covered by slashMenuPlugin.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    createSlashMenu,
    slashRowDomId,
    SLASH_MENU_DOM_ID,
    type SlashMenuHandle,
} from "../components/slashMenu";
import { SLASH_MENU_ITEMS } from "../components/slashMenu/registry";

function rowEls(): HTMLElement[] {
    return Array.from(document.querySelectorAll(".slash-menu-item"));
}

function rowLabels(): string[] {
    return rowEls().map(
        (el) => el.querySelector(".slash-menu-item-label")?.textContent ?? "",
    );
}

function focusedRow(): HTMLElement | null {
    return document.querySelector(".slash-menu-item--focused");
}

function mousedown(el: Element): MouseEvent {
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
}

describe("createSlashMenu", () => {
    let onPick: ReturnType<typeof vi.fn>;
    let onActiveChange: ReturnType<typeof vi.fn>;
    let menu: SlashMenuHandle;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        onPick = vi.fn();
        onActiveChange = vi.fn();
        menu = createSlashMenu({ onPick, onActiveChange });
    });

    it("mounting should render every registry item with group headers", () => {
        expect(document.getElementById(SLASH_MENU_DOM_ID)).not.toBeNull();
        expect(rowEls()).toHaveLength(SLASH_MENU_ITEMS.length);
        const headers = Array.from(
            document.querySelectorAll(".slash-menu-group-label"),
        ).map((el) => el.textContent);
        expect(headers).toEqual(["Basic blocks", "Advanced"]);
    });

    it("rows should carry listbox/option aria roles and stable ids", () => {
        expect(
            document.getElementById(SLASH_MENU_DOM_ID)?.getAttribute("role"),
        ).toBe("listbox");
        for (const item of SLASH_MENU_ITEMS) {
            const row = document.getElementById(slashRowDomId(item.id));
            expect(row, `row for "${item.id}"`).not.toBeNull();
            expect(row!.getAttribute("role")).toBe("option");
        }
    });

    it("a heading row should render its text badge and markdown hint", () => {
        const h1 = document.getElementById(slashRowDomId("heading1"))!;
        expect(h1.querySelector(".slash-menu-item-badge")?.textContent).toBe("H1");
        expect(h1.querySelector(".slash-menu-item-hint")?.textContent).toBe("#");
    });

    it("the first row should be highlighted on mount and after re-filtering", () => {
        expect(focusedRow()?.id).toBe(slashRowDomId(SLASH_MENU_ITEMS[0].id));

        menu.setQuery("head");
        expect(focusedRow()?.id).toBe(slashRowDomId("heading1"));
        expect(onActiveChange).toHaveBeenLastCalledWith(slashRowDomId("heading1"));
    });

    it("filtering should suppress group headers (flat ranked list)", () => {
        menu.setQuery("head");
        expect(document.querySelectorAll(".slash-menu-group-label")).toHaveLength(0);
        expect(rowLabels()).toEqual(["Heading 1", "Heading 2", "Heading 3"]);
    });

    it("a zero-match query should hide the menu but keep it alive", () => {
        menu.setQuery("zzzz");
        expect(menu.isVisible()).toBe(false);
        expect(
            (document.getElementById(SLASH_MENU_DOM_ID) as HTMLElement).style.display,
        ).toBe("none");
        expect(menu.pickActive()).toBe(false);

        menu.setQuery("table");
        expect(menu.isVisible()).toBe(true);
        expect(
            (document.getElementById(SLASH_MENU_DOM_ID) as HTMLElement).style.display,
        ).not.toBe("none");
    });

    it("moveActive should wrap in both directions", () => {
        menu.setQuery("head"); // 3 rows, first highlighted
        menu.moveActive(-1);
        expect(focusedRow()?.id).toBe(slashRowDomId("heading3"));
        menu.moveActive(1);
        expect(focusedRow()?.id).toBe(slashRowDomId("heading1"));
    });

    it("pickActive should apply the highlighted item", () => {
        menu.setQuery("quo");
        expect(menu.pickActive()).toBe(true);
        expect(onPick).toHaveBeenCalledWith(
            expect.objectContaining({ id: "blockquote" }),
        );
    });

    it("row mousedown should pick and prevent the focus-stealing default", () => {
        const row = document.getElementById(slashRowDomId("table"))!;
        const ev = mousedown(row);
        expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "table" }));
        expect(ev.defaultPrevented).toBe(true);
    });

    it("hovering a row should move the highlight and report it", () => {
        const row = document.getElementById(slashRowDomId("math"))!;
        row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        expect(focusedRow()?.id).toBe(slashRowDomId("math"));
        expect(onActiveChange).toHaveBeenLastCalledWith(slashRowDomId("math"));
    });

    it("a menu placed near the viewport bottom should flip above the anchor", () => {
        const gbcr = vi
            .spyOn(Element.prototype, "getBoundingClientRect")
            .mockReturnValue({
                top: 0, bottom: 0, left: 0, right: 0,
                width: 220, height: 200, x: 0, y: 0,
                toJSON: () => ({}),
            } as DOMRect);

        // jsdom viewport is 768px tall; below would be 700..900 (overflow),
        // and there is more room above → bottom edge sits at flipTop.
        menu.position({ left: 10, top: 700, flipTop: 680 });
        expect((document.getElementById(SLASH_MENU_DOM_ID) as HTMLElement).style.top)
            .toBe("480px");

        gbcr.mockRestore();
    });

    it("the footer hint should render, marked decorative for AT", () => {
        const footer = document.querySelector(".slash-menu-footer");
        expect(footer).not.toBeNull();
        expect(footer!.getAttribute("aria-hidden")).toBe("true");
        expect(footer!.textContent).toContain("Type to filter");
        expect(footer!.querySelector(".slash-menu-footer-key")?.textContent).toBe("esc");
    });

    it("an items override should limit what renders and what picks resolve to", () => {
        menu.destroy();
        const subset = SLASH_MENU_ITEMS.filter((i) => i.id !== "bulletList");
        menu = createSlashMenu({ onPick, onActiveChange, items: subset });

        expect(document.getElementById(slashRowDomId("bulletList"))).toBeNull();
        expect(rowEls()).toHaveLength(SLASH_MENU_ITEMS.length - 1);
        menu.setQuery("bullet"); // only the excluded item would match its label
        expect(rowLabels()).not.toContain("Bullet List");
    });

    it("destroy should remove the menu DOM", () => {
        menu.destroy();
        expect(document.getElementById(SLASH_MENU_DOM_ID)).toBeNull();
    });
});
