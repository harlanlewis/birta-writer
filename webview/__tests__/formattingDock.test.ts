/**
 * The formatting row's open state is the HOST'S SETTING
 * (components/toolbar/dock.ts): read from the bootstrap when the row is built,
 * and applied when the host pushes it. The page has no control that flips it
 * and therefore posts nothing at all.
 *
 * The silence is the half a green page cannot show. A page that echoed a push
 * back would drive its siblings to the same answer it already holds, so every
 * window would look right while the host was being told what it had just said;
 * `posted()` is what makes that visible.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { createFormattingDock } from "../components/toolbar/dock";
import type { ToolbarItemId } from "../components/toolbar/registry";

function boot(expanded: boolean | undefined): void {
    (window as unknown as { __i18n: unknown }).__i18n = {
        translations: {},
        isMac: true,
        ...(expanded === undefined ? {} : { formattingRowExpanded: expanded }),
    };
}

const posted = (): unknown[] =>
    mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type?: string })
        .filter((m) => m.type === "formattingRowExpanded");

describe("the formatting row's open state", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("an absent bootstrap flag should build the row shut, and a true one open", () => {
        boot(undefined);
        const shut = createFormattingDock({ items: {} });
        expect(shut.isExpanded()).toBe(false);
        expect(shut.el.hidden).toBe(true);
        shut.dispose();
        boot(true);
        const open = createFormattingDock({ items: {} });
        expect(open.isExpanded()).toBe(true);
        expect(open.el.hidden).toBe(false);
        expect(posted()).toEqual([]);
        open.dispose();
    });

    it("the row should carry no control of its own, so a press on it cannot flip the setting", () => {
        // The toggle that used to lead the top bar is gone: whether the row
        // exists is answered in the host's Settings window, not on the bar.
        // Asserted as the ABSENCE of any pressable chrome outside the row's
        // own scroll affordances, rather than as "the old class is gone",
        // which would pass on a build that merely renamed it.
        boot(true);
        const dock = createFormattingDock({ items: {} });
        const pressable = [...dock.el.querySelectorAll("button")]
            .filter((b) => !b.classList.contains("tb-dock-scroll"));
        expect(pressable).toEqual([]);
        expect(dock.el.querySelector(".tb-dock-toggle")).toBeNull();
        expect(posted()).toEqual([]);
        dock.dispose();
    });

    it("the host's push should move the row and post nothing back", () => {
        boot(false);
        const dock = createFormattingDock({ items: {} });
        dock.setExpanded(true);
        expect(dock.isExpanded()).toBe(true);
        expect(dock.el.hidden).toBe(false);
        dock.setExpanded(false);
        expect(dock.isExpanded()).toBe(false);
        expect(posted()).toEqual([]);
        dock.dispose();
    });

    it("a push that changes nothing should change nothing, so the origin page's own echo is inert", () => {
        boot(true);
        const dock = createFormattingDock({ items: {} });
        dock.setExpanded(true);
        expect(dock.isExpanded()).toBe(true);
        expect(posted()).toEqual([]);
        dock.dispose();
    });
});

describe("the formatting row's grouping", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        boot(true);
    });

    /** One wrapper per id, so the row has something real to place. */
    const wrappers = (ids: readonly ToolbarItemId[]): Partial<Record<ToolbarItemId, HTMLElement>> =>
        Object.fromEntries(ids.map((id) => {
            const el = document.createElement("div");
            el.className = "tb-item";
            el.dataset["itemId"] = id;
            return [id, el];
        }));

    /** What the row actually holds, in order: an item's id or "|" for a rule. */
    const shape = (row: Element): string[] =>
        [...row.children].map((el) =>
            el.classList.contains("tb-dock-sep") ? "|" : (el as HTMLElement).dataset["itemId"] ?? "?");

    it("a rule should fall between runs of different kinds and nowhere else", () => {
        const ids: ToolbarItemId[] = ["format", "bold", "italic", "listMenu", "table", "clearFormatting"];
        const dock = createFormattingDock({ items: wrappers(ids) });
        dock.render(ids);
        const row = dock.el.querySelector(".tb-dock-row")!;
        expect(shape(row)).toEqual([
            "format", "|", "bold", "italic", "|", "listMenu", "|", "table", "|", "clearFormatting",
        ]);
        // Never at an end. A leading or trailing rule is a boundary with
        // nothing on one side of it, and it is the shape a naive "append a
        // rule after each run" produces.
        expect(shape(row)[0]).not.toBe("|");
        expect(shape(row).at(-1)).not.toBe("|");
        dock.dispose();
    });

    it("one run should carry no rule at all", () => {
        const ids: ToolbarItemId[] = ["bold", "italic", "link"];
        const dock = createFormattingDock({ items: wrappers(ids) });
        dock.render(ids);
        expect(shape(dock.el.querySelector(".tb-dock-row")!)).toEqual(["bold", "italic", "link"]);
        dock.dispose();
    });

    it("a run whose every item the host declined should leave no gap and no rule", () => {
        // `render` is given ids, and `items` is what was actually BUILT. A host
        // that built none of a run's items must not be charged a divider for
        // it, which is the case a "rule per run boundary" count gets wrong:
        // the boundary is still there, and the run behind it is not.
        const ids: ToolbarItemId[] = ["format", "bold", "table"];
        const built = wrappers(["format", "table"]);   // the mark run is missing
        const dock = createFormattingDock({ items: built });
        dock.render(ids);
        expect(shape(dock.el.querySelector(".tb-dock-row")!)).toEqual(["format", "|", "table"]);
        dock.dispose();
    });

    it("a rule should announce itself as one, on the row's own axis", () => {
        const ids: ToolbarItemId[] = ["bold", "table"];
        const dock = createFormattingDock({ items: wrappers(ids) });
        dock.render(ids);
        const sep = dock.el.querySelector(".tb-dock-sep")!;
        expect(sep.getAttribute("role")).toBe("separator");
        expect(sep.getAttribute("aria-orientation")).toBe("vertical");
        dock.dispose();
    });

    it("re-rendering should replace the rules, never accumulate them", () => {
        const ids: ToolbarItemId[] = ["format", "bold"];
        const dock = createFormattingDock({ items: wrappers(ids) });
        dock.render(ids);
        dock.render(ids);
        dock.render(ids);
        expect(dock.el.querySelectorAll(".tb-dock-sep")).toHaveLength(1);
        dock.dispose();
    });
});
