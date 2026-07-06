import { describe, it, expect, afterEach } from "vitest";
import { computeMenuPlacement, placeMenu } from "../components/toolbar/menuPlacement";

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
