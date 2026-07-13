/**
 * Regression tests for the toolbar dropdown item-pick Escape-layer leak:
 * the menus' item handlers used to dismiss their dropdown via a direct
 * `menu.style.display = "none"` instead of the shared close owned by
 * wireHoverMenu — leaving the Escape-layer entry registered (the NEXT
 * editor-focused Escape was silently swallowed), `aria-expanded="true"` /
 * `tb-menu-open` stale, and re-registration suppressed on reopen (the
 * leaked `escapeOff ??=`). Every pick must route through the shared close.
 *
 * Drives the REAL toolbar (initToolbar) against a REAL Milkdown editor,
 * picking via the keyboard path (Enter on the trigger opens and focuses a
 * row; Enter on the row replays the mousedown its handler listens for).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { configureSerialization, pureCommonmark } from "../serialization";
import { initToolbar } from "../components/toolbar";
import { closeTopmostLayer } from "../ui/escapeLayers";

let editors: Editor[] = [];

async function makeEditor(md: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        .create();
    editors.push(editor);
    return editor;
}

function buildToolbar(getEditor: () => Editor | null): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, getEditor);
    return topbar;
}

const key = (k: string): KeyboardEvent =>
    new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

/** The hover-menu trigger button of a toolbar item (wireHoverMenu marks it). */
function trigger(topbar: HTMLElement, itemId: string): HTMLElement {
    const btn = topbar.querySelector<HTMLElement>(
        `[data-item-id="${itemId}"] [aria-haspopup="menu"]`,
    );
    expect(btn, `trigger for ${itemId}`).not.toBeNull();
    return btn!;
}

/**
 * Open a dropdown via the keyboard, Enter-pick `row`, and assert the shared
 * close ran: menu hidden, aria/tb-menu-open reset, and — the regression —
 * the Escape-layer stack empty, then exactly one entry on reopen.
 */
function pickAndAssertClean(topbar: HTMLElement, itemId: string, rowSelector: string): void {
    const wrap = topbar.querySelector<HTMLElement>(`[data-item-id="${itemId}"] .tb-fmt-wrap`)
        ?? topbar.querySelector<HTMLElement>(`[data-item-id="${itemId}"]`)!;
    const btn = trigger(topbar, itemId);

    // Keyboard open (Enter on the trigger).
    btn.dispatchEvent(key("Enter"));
    expect(btn.getAttribute("aria-expanded"), `${itemId} opened`).toBe("true");

    // Keyboard pick: Enter on the row replays the mousedown its handler
    // listens for (hoverMenu's onMenuKeydown).
    const row = topbar.querySelector<HTMLElement>(rowSelector);
    expect(row, `row ${rowSelector}`).not.toBeNull();
    row!.dispatchEvent(key("Enter"));

    // The shared close ran — no stale open state...
    expect(btn.getAttribute("aria-expanded"), `${itemId} aria after pick`).toBe("false");
    expect(
        wrap.querySelector(".tb-menu-open") ?? wrap.classList.contains("tb-menu-open"),
        `${itemId} tb-menu-open after pick`,
    ).toBeFalsy();
    // ...and, the regression itself: no leaked Escape-layer entry to swallow
    // the next editor-focused Escape.
    expect(closeTopmostLayer(), `${itemId} layer stack after pick`).toBe(false);

    // Reopen: exactly one live entry again (a leaked escapeOff used to
    // suppress re-registration via `escapeOff ??=`, leaving a dead stack slot).
    btn.dispatchEvent(key("Enter"));
    expect(closeTopmostLayer(), `${itemId} layer on reopen`).toBe(true);
    expect(closeTopmostLayer(), `${itemId} single layer on reopen`).toBe(false);
}

beforeEach(() => {
    // Drain layer entries left behind by other tests (module-level stack).
    while (closeTopmostLayer()) { /* drain */ }
});

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("toolbar dropdown item picks and the Escape-layer stack", () => {
    it("a Format pick should leave no layer entry and reset the open state", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        pickAndAssertClean(topbar, "format", '[data-item-id="format"] .tb-fmt-item');
    });

    it("a List pick should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        pickAndAssertClean(topbar, "listMenu", '[data-item-id="listMenu"] .tb-list-item');
    });

    it("a Code-family pick should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        pickAndAssertClean(topbar, "codeBlock", '[data-item-id="codeBlock"] .tb-callout-item');
    });

    it("a Quote/callout pick should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        pickAndAssertClean(topbar, "quote", '[data-item-id="quote"] .tb-callout-item');
    });

    it("a font-preset pick should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        pickAndAssertClean(topbar, "fontPreset", '[data-item-id="fontPreset"] .tb-font-item');
    });

    it("the Font settings entry should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        // The last .tb-fmt-item in the font menu is the "Font settings" jump
        // (excluding the family presets and the block-handles radio rows).
        const rows = Array.from(topbar.querySelectorAll<HTMLElement>(
            '[data-item-id="fontPreset"] .tb-fmt-menu > .tb-fmt-item:not(.tb-font-item):not(.tb-check-item)',
        ));
        expect(rows.length).toBe(1);
        const btn = trigger(topbar, "fontPreset");
        btn.dispatchEvent(key("Enter"));
        rows[0]!.dispatchEvent(key("Enter"));
        expect(btn.getAttribute("aria-expanded")).toBe("false");
        expect(closeTopmostLayer()).toBe(false);
    });

    it("a Settings (gear) entry pick should leave no layer entry", async () => {
        const editor = await makeEditor("hello");
        const topbar = buildToolbar(() => editor);
        // Last entry (Open Extension Settings) — the earlier ones mutate
        // toolbar mode/visibility, which is irrelevant to layer bookkeeping.
        const rows = topbar.querySelectorAll<HTMLElement>(
            '[data-item-id="settings"] .tb-settings-menu .tb-fmt-item',
        );
        expect(rows.length).toBeGreaterThan(0);
        const btn = trigger(topbar, "settings");
        btn.dispatchEvent(key("Enter"));
        rows[rows.length - 1]!.dispatchEvent(key("Enter"));
        expect(btn.getAttribute("aria-expanded")).toBe("false");
        expect(closeTopmostLayer()).toBe(false);
    });
});
