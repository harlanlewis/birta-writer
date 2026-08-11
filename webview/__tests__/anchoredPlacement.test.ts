import { describe, it, expect, afterEach } from "vitest";
import {
    computeMenuPlacement,
    placeMenu,
    computeAnchoredPosition,
    clampLeft,
    pinIntoView,
} from "../ui/anchoredPlacement";

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 300 };

// A button rect of the given left edge (28px tall, near the top toolbar).
function btn(left: number, top = 40, w = 32, h = 28) {
    return { left, right: left + w, top, bottom: top + h };
}

describe("computeMenuPlacement — horizontal", () => {
    it("a left-edge button opens rightward (left-aligned)", () => {
        expect(computeMenuPlacement(btn(10), MENU, VIEWPORT).alignRight).toBe(false);
    });

    it("a right-edge button opens leftward (right-aligned)", () => {
        // Button near the right edge: opening rightward would overflow, and
        // right-aligning fits.
        expect(computeMenuPlacement(btn(950), MENU, VIEWPORT).alignRight).toBe(true);
    });

    it("a centered button whose menu still fits rightward stays left-aligned", () => {
        expect(computeMenuPlacement(btn(500), MENU, VIEWPORT).alignRight).toBe(false);
    });

    it("falls back to left-aligned when neither side fits", () => {
        // Narrow viewport, wide menu: right-align can't fit either, so don't flip
        // (clipping the right is no worse than clipping the left, and left-align
        // keeps the button's own edge visible).
        const narrow = { width: 150, height: 800 };
        expect(computeMenuPlacement(btn(60), MENU, narrow).alignRight).toBe(false);
    });
});

describe("computeMenuPlacement — vertical", () => {
    it("opens below when there is room", () => {
        expect(computeMenuPlacement(btn(10, 40), MENU, VIEWPORT).flipUp).toBe(false);
    });

    it("flips above when below overflows and above fits", () => {
        // Button low in a tall-menu situation, with room above.
        expect(computeMenuPlacement(btn(10, 600), MENU, VIEWPORT).flipUp).toBe(true);
    });

    it("stays below when neither below nor above fits", () => {
        // Menu taller than the viewport: can't fit either way, so don't flip up
        // (opening down keeps the button and the menu's top rows visible).
        const tallMenu = { width: 200, height: 900 };
        expect(computeMenuPlacement(btn(10, 40), tallMenu, VIEWPORT).flipUp).toBe(false);
    });
});

describe("placeMenu — DOM application (stubbed geometry)", () => {
    const realW = window.innerWidth;
    const realH = window.innerHeight;
    function setViewport(w: number, h: number): void {
        Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
    }
    afterEach(() => {
        Object.defineProperty(window, "innerWidth", { value: realW, configurable: true });
        Object.defineProperty(window, "innerHeight", { value: realH, configurable: true });
    });

    function makeButton(rect: { left: number; right: number; top: number; bottom: number }): HTMLButtonElement {
        const b = document.createElement("button");
        b.getBoundingClientRect = () => ({
            left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            x: rect.left, y: rect.top,
            width: rect.right - rect.left, height: rect.bottom - rect.top,
            toJSON: () => ({}),
        }) as DOMRect;
        return b;
    }
    function makeMenu(width: number, height: number): HTMLElement {
        const m = document.createElement("div");
        Object.defineProperty(m, "offsetWidth", { value: width, configurable: true });
        Object.defineProperty(m, "offsetHeight", { value: height, configurable: true });
        return m;
    }

    it("a left-edge button opens rightward and downward", () => {
        setViewport(1000, 800);
        const menu = makeMenu(200, 300);
        placeMenu(makeButton({ left: 10, right: 42, top: 40, bottom: 68 }), menu);
        expect(menu.style.left).toBe("0px"); // "0" normalizes to "0px"
        expect(menu.style.right).toBe("auto");
        expect(menu.style.top).toBe("calc(100% + 6px)");
        expect(menu.style.bottom).toBe("auto");
    });

    it("a right-edge button opens leftward", () => {
        setViewport(1000, 800);
        const menu = makeMenu(200, 300);
        placeMenu(makeButton({ left: 950, right: 982, top: 40, bottom: 68 }), menu);
        expect(menu.style.left).toBe("auto");
        expect(menu.style.right).toBe("0px"); // "0" normalizes to "0px"
    });

    it("a button low in the viewport flips the menu upward", () => {
        setViewport(1000, 800);
        const menu = makeMenu(200, 300);
        placeMenu(makeButton({ left: 10, right: 42, top: 700, bottom: 728 }), menu);
        expect(menu.style.top).toBe("auto");
        expect(menu.style.bottom).toBe("calc(100% + 6px)");
    });
});

describe("clampLeft", () => {
    it("a left inside the viewport should pass through unchanged", () => {
        expect(clampLeft(300, 200, VIEWPORT)).toBe(300);
    });

    it("a left overflowing the right edge should clamp to width minus margin", () => {
        // 1000 - 200 - 8
        expect(clampLeft(900, 200, VIEWPORT)).toBe(792);
    });

    it("a negative left should clamp to the margin", () => {
        expect(clampLeft(-40, 200, VIEWPORT)).toBe(8);
    });

    it("minLeft 0 should allow hugging the left edge (frontmatter rule)", () => {
        expect(clampLeft(3, 200, VIEWPORT, 8, 0)).toBe(3);
        expect(clampLeft(-3, 200, VIEWPORT, 8, 0)).toBe(0);
    });
});

describe("computeAnchoredPosition — vertical", () => {
    // A 100px-wide anchor row; the popup is 200x300 unless stated.
    function anchorAt(top: number, bottom: number, left = 100) {
        return { left, right: left + 100, top, bottom };
    }

    it("an anchor high in the viewport should place the popup below with the gap", () => {
        const p = computeAnchoredPosition(anchorAt(40, 60), MENU, VIEWPORT, { gap: 6 });
        expect(p.above).toBe(false);
        expect(p.top).toBe(66); // bottom 60 + gap 6
    });

    it("larger-side policy should stay below when below overflows but is still the larger side", () => {
        // spaceBelow = 800 - 550 = 250 (< 300 + 8), spaceAbove = 200: stay below.
        const p = computeAnchoredPosition(anchorAt(200, 550), MENU, VIEWPORT);
        expect(p.above).toBe(false);
    });

    it("larger-side policy should flip above when below overflows and above is larger", () => {
        // spaceBelow = 800 - 620 = 180 (< 308), spaceAbove = 600: flip.
        const p = computeAnchoredPosition(anchorAt(600, 620), MENU, VIEWPORT, { gap: 6 });
        expect(p.above).toBe(true);
        expect(p.top).toBe(294); // top 600 - gap 6 - height 300
    });

    it("overflow policy should flip above even when above is the smaller side", () => {
        // spaceBelow = 250 > spaceAbove = 200, but below doesn't fit: flip anyway.
        const p = computeAnchoredPosition(anchorAt(200, 550), MENU, VIEWPORT, {
            flipPolicy: "overflow",
        });
        expect(p.above).toBe(true);
    });

    it("fitSlack should widen the fits-below requirement", () => {
        // spaceBelow = 310: fits a 300 popup with slack 8, not with slack 20.
        const loose = computeAnchoredPosition(anchorAt(200, 490), MENU, VIEWPORT, {
            flipPolicy: "overflow", fitSlack: 8,
        });
        const strict = computeAnchoredPosition(anchorAt(200, 490), MENU, VIEWPORT, {
            flipPolicy: "overflow", fitSlack: 20,
        });
        expect(loose.above).toBe(false);
        expect(strict.above).toBe(true);
    });

    it("fitHeight should drive the flip decision instead of the measured height", () => {
        // Measured height 40 fits below easily, but the reserved 240 does not
        // (spaceBelow = 200) and above (700) is larger: flip.
        const p = computeAnchoredPosition(anchorAt(700, 600), { width: 200, height: 40 }, VIEWPORT, {
            fitHeight: 240, fitSlack: 0, gap: 2,
        });
        expect(p.above).toBe(true);
        // cssBottom pins the popup's bottom edge `gap` above the anchor top.
        expect(p.cssBottom).toBe(102); // 800 - 700 + 2
    });

    it("a below placement should still report the cssBottom of a hypothetical flip", () => {
        const p = computeAnchoredPosition(anchorAt(40, 60), MENU, VIEWPORT, { gap: 2 });
        expect(p.cssBottom).toBe(762); // 800 - 40 + 2
    });
});

// The usable area's top edge is the fixed chrome's bottom (topbar + sticky
// heading), not 0 — a popup placed above it is painted over by an opaque bar
// and is invisible AND unclickable, while the code that placed it believes it
// succeeded. Every case here reads against a 40px inset.
describe("computeAnchoredPosition — safe-area top inset", () => {
    const INSET = { width: 1000, height: 800, top: 40 };
    function anchorAt(top: number, bottom: number, left = 100) {
        return { left, right: left + 100, top, bottom };
    }

    it("a flip that would land in the chrome band should floor at the safe top", () => {
        // A tall anchor: below doesn't fit (spaceBelow 300 < 308), so it flips
        // — and the flip lands at 300 - 6 - 300 = -6, inside the band.
        const p = computeAnchoredPosition(anchorAt(300, 500), MENU, INSET, {
            gap: 6, flipPolicy: "overflow",
        });
        expect(p.above).toBe(true);
        expect(p.top).toBe(40);
    });

    it("the same anchor without an inset should still floor at zero", () => {
        const p = computeAnchoredPosition(anchorAt(300, 500), MENU, VIEWPORT, {
            gap: 6, flipPolicy: "overflow",
        });
        expect(p.above).toBe(true);
        expect(p.top).toBe(0);
    });

    it("space above should be measured net of the inset, not from zero", () => {
        // spaceBelow = 800 - 360 = 440; spaceAbove = 350 - 40 = 310. Below is
        // the larger side once the band is discounted, so no flip — measured
        // from 0 the 350px above would have won and hidden the popup.
        const p = computeAnchoredPosition(anchorAt(350, 360), { width: 200, height: 500 }, INSET);
        expect(p.above).toBe(false);
    });

    it("an anchor scrolled under the chrome should push its popup clear of the band", () => {
        // The anchor's bottom is inside the band, so "below" starts at the
        // safe top rather than following the anchor underneath the bar.
        const p = computeAnchoredPosition(anchorAt(-40, 10), MENU, INSET, { gap: 6 });
        expect(p.above).toBe(false);
        expect(p.top).toBe(40);
    });

    it("a squeezed popup should report the space it actually has", () => {
        // Below the anchor: 800 - 8 - (620 + 6) = 166 of usable height.
        const p = computeAnchoredPosition(anchorAt(600, 620), { width: 200, height: 600 }, INSET, {
            gap: 6, flipPolicy: "larger-side",
        });
        expect(p.above).toBe(true);
        // Above: spaceAbove (600 - 40) minus the gap.
        expect(p.maxHeight).toBe(554);
    });

    it("maxHeight should never collapse below the readable floor", () => {
        // A pane so short that the band leaves negative room: report the
        // floor and let the popup scroll, rather than a nonsense height.
        const p = computeAnchoredPosition(anchorAt(80, 90), MENU, { width: 400, height: 100, top: 40 }, { gap: 6 });
        expect(p.maxHeight).toBe(48);
    });

    it("a hidden toolbar (inset 0) should reproduce the pre-inset placement", () => {
        const withBar = computeAnchoredPosition(anchorAt(200, 220), MENU, INSET, { gap: 6 });
        const noBar = computeAnchoredPosition(anchorAt(200, 220), MENU, VIEWPORT, { gap: 6 });
        expect(noBar.top).toBe(withBar.top); // both place below, unaffected
        expect(noBar.above).toBe(false);
    });
});

describe("computeMenuPlacement — safe-area top inset", () => {
    it("a menu that would flip up into the chrome band should stay below", () => {
        // Room above the anchor (60) exceeds the margin, but not once the
        // 40px band is discounted, so the upward flip is refused.
        const anchor = { left: 100, right: 140, top: 60, bottom: 780 };
        const menu = { width: 200, height: 40 };
        expect(computeMenuPlacement(anchor, menu, { width: 1000, height: 800 }).flipUp).toBe(true);
        expect(
            computeMenuPlacement(anchor, menu, { width: 1000, height: 800, top: 40 }).flipUp,
        ).toBe(false);
    });
});

describe("computeAnchoredPosition — horizontal", () => {
    it("the returned left should be clamped into the viewport", () => {
        const p = computeAnchoredPosition(
            { left: 950, right: 980, top: 40, bottom: 60 },
            MENU,
            VIEWPORT,
        );
        expect(p.left).toBe(792); // 1000 - 200 - 8
    });

    it("minLeft should flow through to the horizontal clamp", () => {
        const p = computeAnchoredPosition(
            { left: 2, right: 30, top: 40, bottom: 60 },
            MENU,
            VIEWPORT,
            { minLeft: 0 },
        );
        expect(p.left).toBe(2);
    });
});

/**
 * `pinIntoView` is the rule for chrome that cannot flip: a block's own
 * controls, whose anchor is the block itself. The two clamps and the order
 * between them are the whole of it, so the cases below are the four states a
 * tall block passes through as it scrolls by, plus the degenerate one.
 */
describe("pinIntoView", () => {
    // A band below a 40px topbar, 800px viewport, 8px bottom margin.
    const VIEW = { start: 40, end: 792 };
    const SIZE = 12;

    it("a block fully in view should leave its chrome at rest", () => {
        const block = { start: 200, end: 600 };
        expect(pinIntoView(200, SIZE, block, VIEW)).toBe(200);
    });

    it("a resting place under the fixed chrome should slide down to the band", () => {
        // Tall block scrolled so its top is off screen; the chrome follows the
        // band's top edge instead of leaving with the edge it rests on.
        const block = { start: -500, end: 900 };
        expect(pinIntoView(-500, SIZE, block, VIEW)).toBe(40);
    });

    it("a resting place below the fold should slide up into the band", () => {
        const block = { start: 1200, end: 2000 };
        // Not yet scrolled to: the block wins, so the chrome stays off screen
        // rather than sitting at the bottom edge pointing at nothing.
        expect(pinIntoView(1200, SIZE, block, VIEW)).toBe(1200);
    });

    it("a block scrolled off the top should take its chrome with it", () => {
        // The block clamp runs SECOND and therefore wins: chrome for a block
        // nobody can see must be gone too, not parked under the topbar.
        const block = { start: -900, end: -300 };
        expect(pinIntoView(-900, SIZE, block, VIEW)).toBe(-312); // block.end - size
    });

    it("a block ending inside the band should stop its chrome at the block's end", () => {
        // Scrolling on: the strip rides the band's top edge until the block's
        // own bottom catches up with it, then travels up with the block.
        expect(pinIntoView(-500, SIZE, { start: -500, end: 400 }, VIEW)).toBe(40);
        expect(pinIntoView(-500, SIZE, { start: -500, end: 45 }, VIEW)).toBe(33);
    });

    it("a block shorter than its own chrome should still pin to the block's start", () => {
        // Degenerate but reachable (a one-row table mid-collapse): `end - size`
        // is above `start`, and the start must win rather than invert the range.
        const block = { start: 300, end: 305 };
        expect(pinIntoView(300, SIZE, block, VIEW)).toBe(300);
    });
});
