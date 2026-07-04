/**
 * Toolbar overflow tests (MAR-10): pure collapse math plus the DOM
 * controller that reparents groups into/out of the ⋯ panel. Widths are
 * stubbed via an injected `measure` because jsdom performs no layout.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    computeOverflow,
    createOverflowController,
} from "../components/toolbar/overflow";
import type { OverflowGroup } from "../components/toolbar/overflow";

describe("computeOverflow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("groups that exactly fit should collapse nothing", () => {
        // Arrange
        const widths = [50, 50, 50];

        // Act
        const collapsed = computeOverflow(widths, [2, 1, 0], 150, 20);

        // Assert
        expect(collapsed.size).toBe(0);
    });

    it("a single-group overflow should collapse only the first group in collapse order", () => {
        // Arrange: total 150 > available 140; dropping index 2 fits the budget
        const widths = [50, 50, 50];

        // Act
        const collapsed = computeOverflow(widths, [2, 1, 0], 140, 20);

        // Assert
        expect([...collapsed]).toEqual([2]);
    });

    it("a very narrow pane should collapse every collapsible group", () => {
        // Arrange: only indices 2 and 1 are collapsible
        const widths = [50, 50, 50];

        // Act
        const collapsed = computeOverflow(widths, [2, 1], 40, 20);

        // Assert
        expect([...collapsed].sort()).toEqual([1, 2]);
    });

    it("groups outside the collapse order should never collapse, even at tiny widths", () => {
        // Arrange: index 0 is never-collapse
        const widths = [80, 40, 40];

        // Act
        const collapsed = computeOverflow(widths, [2, 1], 10, 20);

        // Assert
        expect(collapsed.has(0)).toBe(false);
        expect([...collapsed].sort()).toEqual([1, 2]);
    });

    it("the ⋯ button width should be reserved once anything collapses", () => {
        // Arrange: total 114 > available 110. Without reserving the ⋯ width,
        // collapsing only index 2 (-> 100 <= 110) would suffice; with the
        // 20px reservation the budget is 90, so index 1 must collapse too.
        const widths = [50, 50, 14];

        // Act
        const collapsed = computeOverflow(widths, [2, 1], 110, 20);

        // Assert
        expect([...collapsed].sort()).toEqual([1, 2]);
    });

    it("zero-width (hidden) groups should be skipped instead of collapsed", () => {
        // Arrange: index 1 is hidden (width 0), e.g. debug tools disabled
        const widths = [50, 0, 50];

        // Act
        const collapsed = computeOverflow(widths, [1, 2], 60, 10);

        // Assert
        expect(collapsed.has(1)).toBe(false);
        expect([...collapsed]).toEqual([2]);
    });

    it("repeated calls around the fit boundary should be deterministic (no thrash)", () => {
        // Arrange: cached widths make the decision a pure function of `available`
        const widths = [50, 50, 50];

        // Act & Assert: jitter one pixel around the boundary several times
        for (let i = 0; i < 5; i++) {
            expect(computeOverflow(widths, [2, 1], 150, 20).size).toBe(0);
            expect([...computeOverflow(widths, [2, 1], 149, 20)]).toEqual([2]);
        }
    });
});

describe("production group mapping", () => {
    // Mirrors initToolbar: groups in real DOM order and the real collapse
    // order (see webview/components/toolbar/index.ts). Update both places
    // together when the toolbar gains or reorders groups.
    const domOrder = [
        "fmt",
        "inline-core",
        "inline-extra",
        "link",
        "insert",
        "lists",
        "blocks",
        "debug",
        "proofread",
        "utility",
    ];
    const collapseNames = [
        "insert",
        "blocks",
        "lists",
        "inline-extra",
        "proofread",
        "utility",
        "debug",
    ];
    const collapseOrder = collapseNames.map((n) => domOrder.indexOf(n));
    // Uniform 50px groups keep the arithmetic legible; ⋯ button is 30px.
    const widths = domOrder.map(() => 50);

    const collapsedAt = (available: number): string[] =>
        [...computeOverflow(widths, collapseOrder, available, 30)].map(
            (i) => domOrder[i],
        );

    it("shrinking the pane should collapse groups in the documented order", () => {
        // Arrange: total 500; budget = available - 30; each step frees 50
        // Act & Assert: one more group collapses per 50px lost
        expect(collapsedAt(500)).toEqual([]);
        expect(collapsedAt(480)).toEqual(["insert"]);
        expect(collapsedAt(430)).toEqual(["insert", "blocks"]);
        expect(collapsedAt(380)).toEqual(["insert", "blocks", "lists"]);
        expect(collapsedAt(330)).toEqual([
            "insert", "blocks", "lists", "inline-extra",
        ]);
        expect(collapsedAt(280)).toEqual([
            "insert", "blocks", "lists", "inline-extra", "proofread",
        ]);
        expect(collapsedAt(230)).toEqual([
            "insert", "blocks", "lists", "inline-extra", "proofread", "utility",
        ]);
        expect(collapsedAt(180)).toEqual(collapseNames);
    });

    it("fmt, inline-core and link should never collapse, even at zero width", () => {
        // Act
        const collapsed = collapsedAt(0);

        // Assert: every collapsible group is out, the pinned three remain
        expect(collapsed).toEqual(collapseNames);
        expect(collapsed).not.toContain("fmt");
        expect(collapsed).not.toContain("inline-core");
        expect(collapsed).not.toContain("link");
    });
});

describe("createOverflowController", () => {
    /** Stubbed widths keyed by data-w attribute (jsdom has no layout). */
    const measure = (el: HTMLElement): number =>
        Number(el.dataset["w"] ?? "0");

    let toolbar: HTMLElement;
    let panel: HTMLElement;
    let moreWrap: HTMLElement;
    let groups: OverflowGroup[];

    /** Build a toolbar: fmt(40) | sep(9) core(50) | sep(9) insert(60) | sep(9) blocks(60) | ⋯(28) */
    function build(): void {
        toolbar = document.createElement("div");
        panel = document.createElement("div");
        groups = [];

        let pendingSep: HTMLElement | null = null;
        const addSep = (): void => {
            const s = document.createElement("div");
            s.dataset["w"] = "9";
            toolbar.appendChild(s);
            pendingSep = s;
        };
        const addGroup = (name: string, width: number): HTMLElement => {
            const el = document.createElement("div");
            el.dataset["group"] = name;
            el.dataset["w"] = String(width);
            toolbar.appendChild(el);
            groups.push({ name, el, sepBefore: pendingSep });
            pendingSep = null;
            return el;
        };

        addGroup("fmt", 40);
        addSep();
        addGroup("inline-core", 50);
        addSep();
        addGroup("insert", 60);
        addSep();
        addGroup("blocks", 60);

        moreWrap = document.createElement("div");
        moreWrap.dataset["w"] = "28";
        moreWrap.style.display = "none";
        toolbar.appendChild(moreWrap);
        document.body.appendChild(toolbar);
        document.body.appendChild(panel);
    }

    function makeController() {
        return createOverflowController({
            toolbar,
            groups,
            // insert collapses first, then blocks; fmt and inline-core never do
            collapseOrder: [2, 3],
            moreWrap,
            panel,
            measure,
        });
    }

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        build();
    });

    // Group widths incl. leading sep + gaps: fmt 42, core 63, insert 73, blocks 73 → total 251

    it("a wide toolbar should keep every group in place and hide the ⋯ button", () => {
        // Arrange
        const controller = makeController();

        // Act
        controller.update(300);

        // Assert
        expect(controller.collapsedNames()).toEqual([]);
        expect(panel.childElementCount).toBe(0);
        groups.forEach((g) => expect(g.el.parentElement).toBe(toolbar));
        expect(moreWrap.style.display).toBe("none");
    });

    it("a narrow toolbar should reparent overflowing groups into the panel and show ⋯", () => {
        // Arrange
        const controller = makeController();

        // Act: 251 total > 200 → collapse "insert" (budget 200 - 30 = 170 ≥ 178? no → also "blocks")
        controller.update(200);

        // Assert
        expect(controller.collapsedNames()).toEqual(["insert", "blocks"]);
        expect(groups[2]!.el.parentElement).toBe(panel);
        expect(groups[3]!.el.parentElement).toBe(panel);
        expect(groups[2]!.sepBefore!.style.display).toBe("none");
        expect(groups[3]!.sepBefore!.style.display).toBe("none");
        expect(moreWrap.style.display).toBe("");
        // Panel rows keep toolbar order
        expect(panel.children[0]).toBe(groups[2]!.el);
        expect(panel.children[1]).toBe(groups[3]!.el);
    });

    it("widening the pane again should restore groups to their original toolbar slots", () => {
        // Arrange
        const controller = makeController();
        controller.update(150);
        expect(controller.collapsedNames()).toEqual(["insert", "blocks"]);

        // Act
        controller.update(300);

        // Assert: original DOM order restored, separators visible again
        expect(controller.collapsedNames()).toEqual([]);
        const order = [...toolbar.children]
            .filter((el) => (el as HTMLElement).dataset["group"])
            .map((el) => (el as HTMLElement).dataset["group"]);
        expect(order).toEqual(["fmt", "inline-core", "insert", "blocks"]);
        expect(groups[2]!.sepBefore!.style.display).toBe("");
        expect(groups[3]!.sepBefore!.style.display).toBe("");
        expect(moreWrap.style.display).toBe("none");
    });

    it("a button's click handler should still fire after a reparent round-trip", () => {
        // Arrange: a live listener inside the collapsible "insert" group
        const handler = vi.fn();
        const button = document.createElement("button");
        button.addEventListener("mousedown", handler);
        groups[2]!.el.appendChild(button);
        const controller = makeController();

        // Act: collapse into the panel, restore, then click
        controller.update(150);
        controller.update(300);
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        // Assert
        expect(handler).toHaveBeenCalledTimes(1);
        expect(button.parentElement).toBe(groups[2]!.el);
    });

    it("never-collapse groups should stay in the toolbar even at tiny widths", () => {
        // Arrange
        const controller = makeController();

        // Act
        controller.update(10);

        // Assert
        expect(groups[0]!.el.parentElement).toBe(toolbar);
        expect(groups[1]!.el.parentElement).toBe(toolbar);
        expect(controller.collapsedNames()).toEqual(["insert", "blocks"]);
    });

    it("cached natural widths should prevent oscillation when live widths change after collapse", () => {
        // Arrange: first update caches natural widths
        const controller = makeController();
        controller.update(300);

        // Act: pretend the layout now reports different (shrunken) widths,
        // then jitter around the boundary — decisions must stay stable
        groups.forEach((g) => (g.el.dataset["w"] = "1"));
        controller.update(200);
        const first = controller.collapsedNames();
        controller.update(201);
        const second = controller.collapsedNames();
        controller.update(200);
        const third = controller.collapsedNames();

        // Assert: cached widths (not the new "1"s) drive every decision
        expect(first).toEqual(["insert", "blocks"]);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });

    it("a hidden group should be treated as absent and never moved into the panel", () => {
        // Arrange: hide "blocks" (like debug tools when disabled)
        groups[3]!.el.style.display = "none";
        const controller = makeController();

        // Act: 251 - 73 = 178 total; available 160, budget 130 → collapse insert only
        controller.update(160);

        // Assert
        expect(controller.collapsedNames()).toEqual(["insert"]);
        expect(groups[3]!.el.parentElement).toBe(toolbar);
    });
});
