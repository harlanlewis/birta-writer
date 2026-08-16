/**
 * The unread dot on the settings gear: it lights on the host's verdict, it
 * clears when the MENU OPENS, and clearing tells the host exactly once.
 *
 * The clear-on-open contract is the part worth pinning. The dot claims only
 * that something is unseen, so opening the menu is the gesture that answers it;
 * wiring the clear to the What's-new row instead would leave a dot on a user
 * who opened the menu, read the row, and chose not to follow it, which is a nag
 * rather than an indicator. That is a behavioural claim a reader cannot check
 * from the CSS, so it is asserted here.
 *
 * acquireVsCodeApi is injected globally by setup.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { initToolbar } from "../components/toolbar";
import { setWhatsNewUnread } from "../components/toolbar/settingsMenu";

const UNREAD_CLASS = "tb-gear--unread";

function buildToolbar(): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, () => null);
    return topbar;
}

/** The wrap holding the settings gear and its dropdown. */
function settingsWrap(topbar: HTMLElement): HTMLElement {
    const wrap = topbar.querySelector<HTMLElement>(".tb-fmt-wrap:has(.tb-settings-menu)");
    if (!wrap) { throw new Error("settings menu wrap not found"); }
    return wrap;
}

/** The gear trigger: the settings wrap's own button, not a menu row. */
function gear(topbar: HTMLElement): HTMLElement {
    const wrap = settingsWrap(topbar);
    const btn = wrap.querySelector<HTMLElement>("button, .tb-btn, [aria-haspopup]")
        ?? wrap.firstElementChild as HTMLElement | undefined;
    if (!btn) { throw new Error("settings gear trigger not found"); }
    return btn;
}

/**
 * Open the dropdown the way a keyboard user does. The gear is a HOVER menu:
 * `mousedown` does not open it, so a test that used one would assert against a
 * menu that never opened and pass for the wrong reason once the dot cleared
 * some other way.
 */
function openByKeyboard(el: HTMLElement): void {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

/**
 * Open it the way a mouse user does: hover the WRAP (where the listener lives,
 * not the button), then wait past the hover-intent delay.
 */
function openByHover(wrap: HTMLElement): void {
    wrap.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    vi.advanceTimersByTime(500);
}

function seenMessages(): Array<{ type: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string })
        .filter((msg) => msg.type === "whatsNewSeen");
}

describe("what's-new unread indicator", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        window.__i18n = undefined;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
    });

    it("an unread verdict should mark the gear", () => {
        const topbar = buildToolbar();
        expect(gear(topbar).classList.contains(UNREAD_CLASS)).toBe(false);
        setWhatsNewUnread(true);
        expect(gear(topbar).classList.contains(UNREAD_CLASS)).toBe(true);
    });

    it("a read verdict should clear the mark", () => {
        const topbar = buildToolbar();
        setWhatsNewUnread(true);
        setWhatsNewUnread(false);
        expect(gear(topbar).classList.contains(UNREAD_CLASS)).toBe(false);
    });

    it("opening the menu by keyboard should clear the dot and report it seen", () => {
        const topbar = buildToolbar();
        setWhatsNewUnread(true);
        openByKeyboard(gear(topbar));
        expect(gear(topbar).getAttribute("aria-expanded"), "the menu actually opened").toBe("true");
        expect(gear(topbar).classList.contains(UNREAD_CLASS)).toBe(false);
        expect(seenMessages()).toHaveLength(1);
    });

    it("opening the menu by hover should clear the dot and report it seen", () => {
        // The mouse path is the common one and reaches `open()` by a different
        // route (an intent timer, not a key handler), so it is pinned too.
        vi.useFakeTimers();
        try {
            const topbar = buildToolbar();
            setWhatsNewUnread(true);
            openByHover(settingsWrap(topbar));
            expect(gear(topbar).getAttribute("aria-expanded"), "the menu actually opened").toBe("true");
            expect(gear(topbar).classList.contains(UNREAD_CLASS)).toBe(false);
            expect(seenMessages()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("opening the menu with no dot should report nothing", () => {
        // The host stamps a version on every `whatsNewSeen`, so a menu opened
        // routinely must stay silent or the memento churns on every open.
        const topbar = buildToolbar();
        openByKeyboard(gear(topbar));
        expect(gear(topbar).getAttribute("aria-expanded"), "the menu actually opened").toBe("true");
        expect(seenMessages()).toHaveLength(0);
    });

    it("opening the menu twice should report seen only once", () => {
        const topbar = buildToolbar();
        setWhatsNewUnread(true);
        openByKeyboard(gear(topbar));
        openByKeyboard(gear(topbar));
        expect(seenMessages()).toHaveLength(1);
    });
});
