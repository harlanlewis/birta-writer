/**
 * The find bar under `nativeFindBar` (shared/hostProfile.ts): the arrangement
 * that draws the platform's search field instead of VS Code's find widget.
 *
 * The claim this file has to hold is that it IS an arrangement — the same
 * controls, running the same code, in different holders. So every assertion
 * here is about WHERE something is, and the control set is asserted to be
 * unchanged against the same bar built without the declaration. A version of
 * these tests that only checked the native page would pass just as well if the
 * arrangement had quietly dropped a toggle, which is exactly the failure the
 * capability/arrangement distinction exists to prevent.
 *
 * Its own file rather than a block in findBar.test.ts, because the declaration
 * has to be in place BEFORE `initFindBar` runs (the arrangement is read at
 * build time, since it decides which holder each button is built into) and
 * that suite's `setup` is shared by ninety-odd cases that must keep seeing the
 * VS Code bar.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Schema, EditorState, type EditorView, type Transaction } from "../pm";
import { createEventManager } from "../eventManager";
import { initFindBar } from "../components/findBar";
import { closeTopmostLayer } from "../ui/escapeLayers";

const schema = new Schema({
    nodes: {
        doc: { content: "block+" },
        paragraph: { group: "block", content: "inline*" },
        text: { group: "inline" },
    },
});

type Declared = { __i18n?: { isMac?: boolean; host?: { arrangements?: string[] } } };
const g = globalThis as Declared;

let disposeEvents: (() => void) | null = null;

/** Mount a find bar, with or without the arrangement declared. */
function mount(native: boolean): HTMLElement {
    document.body.innerHTML = "";
    if (native) {
        // `isMac` alongside the arrangement, because the surface that declares
        // it is a macOS application: the bar reads this to decide whether its
        // option accelerators are Alt or Cmd+Alt, and jsdom reports a platform
        // that is neither.
        g.__i18n = { isMac: true, host: { arrangements: ["nativeFindBar"] } };
    } else {
        delete g.__i18n;
    }
    const editor = document.createElement("div");
    editor.id = "editor";
    document.body.appendChild(editor);

    const doc = schema.node("doc", null, [
        schema.node("paragraph", null, [schema.text("alpha beta alpha")]),
    ]);
    let state = EditorState.create({ schema, doc });
    const view = {
        get state() { return state; },
        dispatch: (tr: Transaction) => { state = state.apply(tr); },
        dom: document.createElement("div"),
        focus: () => { /* unused */ },
        domAtPos: () => { throw new Error("no DOM"); },
        nodeDOM: () => null,
        coordsAtPos: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    } as unknown as EditorView;

    const events = createEventManager();
    disposeEvents = () => events.dispose();
    initFindBar(() => view, () => "", events);
    return document.querySelector(".find-bar") as HTMLElement;
}

/**
 * Every control on the bar, by the accessible name that identifies it.
 *
 * `[role=switch]` is in the selector because a control is not a tag: under
 * this arrangement the four options are menu rows rather than buttons, and a
 * selector naming only tags would have read their disappearance as the
 * arrangement having dropped them.
 */
function controlNames(bar: HTMLElement): string[] {
    return [...bar.querySelectorAll<HTMLElement>('button, input, [role="switch"]')]
        .map((el) => el.getAttribute("aria-label") ?? "")
        .filter(Boolean)
        .sort();
}

/** One option, wherever this surface put it. */
function option(bar: HTMLElement, name: string): HTMLElement {
    return bar.querySelector(`[aria-label="${name}"]`) as HTMLElement;
}

const OPTIONS = ["Match Case", "Match Whole Word", "Use Regular Expression", "Find in Selection"];

describe("the find bar under nativeFindBar", () => {
    beforeEach(() => { while (closeTopmostLayer()) { /* drain */ } });
    afterEach(() => {
        disposeEvents?.();
        disposeEvents = null;
        delete g.__i18n;
        document.body.innerHTML = "";
    });

    it("an undeclared host should get the bar it has always had", () => {
        const bar = mount(false);
        expect(bar.classList.contains("find-bar--native")).toBe(false);
        expect(bar.querySelector(".find-bar__field")).toBeNull();
        expect(bar.querySelector(".find-bar__options")).toBeNull();
        // The four toggles sit in the find row itself, beside the field.
        for (const name of OPTIONS) {
            const btn = bar.querySelector(`button[aria-label="${name}"]`);
            expect(btn, name).toBeTruthy();
            expect(btn!.closest(".find-bar__options"), name).toBeNull();
        }
    });

    it("a declaring host should get the capsule field, with the input and count inside it", () => {
        const bar = mount(true);
        expect(bar.classList.contains("find-bar--native")).toBe(true);
        const field = bar.querySelector(".find-bar__field");
        expect(field).toBeTruthy();
        expect(field!.querySelector('input[aria-label="Find"]')).toBeTruthy();
        expect(field!.querySelector(".find-bar__count")).toBeTruthy();
        expect(field!.querySelector(".find-bar__glyph")).toBeTruthy();
    });

    // The magnifier is decoration. The input beside it already carries the
    // accessible name, and a second announcement is noise on the way to it.
    it("the magnifier should be hidden from assistive tech", () => {
        const bar = mount(true);
        expect(bar.querySelector(".find-bar__glyph")!.getAttribute("aria-hidden")).toBe("true");
    });

    it("the four options should move into the menu, and nothing else should", () => {
        const bar = mount(true);
        const menu = bar.querySelector(".find-bar__options");
        expect(menu).toBeTruthy();
        const inMenu = [...menu!.querySelectorAll('[role="switch"]')]
            .map((el) => el.getAttribute("aria-label"));
        expect(inMenu.sort()).toEqual([...OPTIONS].sort());
        // Rows of a dropdown, built from the same primitive every other menu
        // in this webview builds one from, rather than the strip's buttons
        // reparented into a box.
        for (const name of OPTIONS) {
            expect(option(bar, name).classList.contains("ui-menu-row"), name).toBe(true);
        }
    });

    // Every option carries the icon column a menu row in this webview has;
    // three of them hold the two-character mark the option wears everywhere it
    // appears, and Find in Selection holds an SVG.
    it("every option row should have a leading icon", () => {
        const bar = mount(true);
        for (const name of OPTIONS) {
            const icon = option(bar, name).querySelector(".tb-list-item-icon");
            expect(icon, name).toBeTruthy();
            expect(icon!.textContent!.length + icon!.querySelectorAll("svg").length, name)
                .toBeGreaterThan(0);
        }
    });

    // The opener carries NO tooltip, and that is the fix rather than a
    // detail: `createButton` places a tooltip directly under the button,
    // which is where this menu opens, so the label sat over the first row the
    // press had just revealed. Every menu opener in this webview is built by
    // `createMenuTrigger` for that reason.
    it("the options opener should carry no tooltip", () => {
        const bar = mount(true);
        const opener = bar.querySelector(".find-bar__options-btn") as HTMLElement;
        expect(opener.getAttribute("aria-label")).toBe("Search Options");
        expect(document.querySelector(".ui-tooltip")).toBeNull();
        opener.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        opener.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        expect(document.querySelector(".ui-tooltip")).toBeNull();
    });

    // THE claim that makes this an arrangement rather than a capability: no
    // search control is added or taken away, and only their holders differ.
    //
    // Two differences are permitted and both are named, because a difference
    // nobody names is how a dropped control would pass. The ⋯ is a HOLDER,
    // which exists only because the options moved into one. Show Replace is
    // the chevron's replacement rather than an addition, so it is written as
    // one name going out and another coming in. Anything else, in either
    // direction, fails. Compared against the real undeclared bar rather than
    // a list written here, which a dropped control would not have joined
    // either.
    it("the two surfaces should differ by the menu opener and the replace toggle's spelling", () => {
        const plain = controlNames(mount(false));
        disposeEvents?.();
        const native = controlNames(mount(true));
        expect(plain).toContain("Toggle Replace");
        expect(native).toEqual(
            [...plain.filter((n) => n !== "Toggle Replace"), "Show Replace", "Search Options"].sort(),
        );
        // A floor, so the comparison is not two empty lists agreeing.
        expect(plain.length).toBeGreaterThanOrEqual(OPTIONS.length + 2);
    });

    describe("the replace row", () => {
        it("its input should sit in the same capsule the find input does", () => {
            const bar = mount(true);
            const input = bar.querySelector('input[aria-label="Replace"]') as HTMLElement;
            // Without a field of its own the input drew no edge at all: the
            // rules that flatten the find input, so its field can carry the
            // ground and the focus ring, reach every input on the bar.
            expect(input.closest(".find-bar__field")).toBeTruthy();
            expect(input.closest(".find-bar__field--find")).toBeNull();
        });

        it("its two actions should be a labelled segmented pair", () => {
            const bar = mount(true);
            const segment = bar.querySelector(".find-bar__segment") as HTMLElement;
            expect(segment).toBeTruthy();
            const labels = [...segment.querySelectorAll("button")].map((b) => b.textContent);
            expect(labels).toEqual(["Replace", "Replace All"]);
        });

        it("should stay two icon buttons on the surface that did not declare it", () => {
            const bar = mount(false);
            expect(bar.querySelector(".find-bar__segment")).toBeNull();
            const replace = bar.querySelector('button[aria-label="Replace"]') as HTMLElement;
            expect(replace.querySelector("svg")).toBeTruthy();
        });
    });

    describe("the replace disclosure", () => {
        it("should be a labelled toggle on the find row, not a chevron beside the rows", () => {
            const bar = mount(true);
            expect(bar.querySelector(".find-bar__toggle")).toBeNull();
            const toggle = bar.querySelector(".find-bar__show-replace") as HTMLButtonElement;
            expect(toggle.textContent).toBe("Show Replace");
            // On the row rather than outside it, which is what stops it
            // moving down half a row when the row it opens appears.
            expect(toggle.closest(".find-bar__row")).toBeTruthy();
        });

        it("pressing it should show the replace row and light the toggle", () => {
            const bar = mount(true);
            const toggle = bar.querySelector(".find-bar__show-replace") as HTMLButtonElement;
            expect(toggle.getAttribute("aria-pressed")).toBe("false");
            toggle.click();
            expect(toggle.getAttribute("aria-pressed")).toBe("true");
            expect(bar.classList.contains("find-bar--replace-visible")).toBe(true);
            toggle.click();
            expect(toggle.getAttribute("aria-pressed")).toBe("false");
            expect(bar.classList.contains("find-bar--replace-visible")).toBe(false);
        });

        it("should stay a chevron on the surface that did not declare it", () => {
            const bar = mount(false);
            const chevron = bar.querySelector(".find-bar__toggle") as HTMLButtonElement;
            expect(chevron).toBeTruthy();
            expect(chevron.querySelector("svg")).toBeTruthy();
            expect(chevron.getAttribute("aria-expanded")).toBe("false");
            chevron.click();
            expect(chevron.getAttribute("aria-expanded")).toBe("true");
        });
    });

    it("Close should be a Done button rather than a square icon", () => {
        const bar = mount(true);
        const close = bar.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
        expect(close.textContent).toBe("Done");
        // `ui-btn--icon`'s fixed square would clip the word.
        expect(close.classList.contains("ui-btn--icon")).toBe(false);
        expect(close.classList.contains("find-bar__done")).toBe(true);
    });

    it("Close should stay an icon button on the surface that did not declare it", () => {
        const bar = mount(false);
        const close = bar.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
        expect(close.classList.contains("ui-btn--icon")).toBe(true);
        expect(close.querySelector("svg")).toBeTruthy();
    });

    describe("the options popover", () => {
        function parts(bar: HTMLElement) {
            return {
                button: bar.querySelector(".find-bar__options-btn") as HTMLButtonElement,
                menu: bar.querySelector(".find-bar__options") as HTMLElement,
            };
        }
        function press(target: HTMLElement): void {
            target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
            target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }

        it("should start closed", () => {
            const { menu, button } = parts(mount(true));
            expect(menu.hidden).toBe(true);
            expect(button.getAttribute("aria-expanded")).toBe("false");
        });

        it("a press on the button should open it, and another should close it", () => {
            const { menu, button } = parts(mount(true));
            press(button);
            expect(menu.hidden).toBe(false);
            expect(button.getAttribute("aria-expanded")).toBe("true");
            press(button);
            expect(menu.hidden).toBe(true);
            expect(button.getAttribute("aria-expanded")).toBe("false");
        });

        it("a press outside should close it", () => {
            const bar = mount(true);
            const { menu, button } = parts(bar);
            press(button);
            expect(menu.hidden).toBe(false);
            press(document.getElementById("editor")!);
            expect(menu.hidden).toBe(true);
        });

        it("a press on a toggle inside should leave it open", () => {
            const bar = mount(true);
            const { menu, button } = parts(bar);
            press(button);
            press(option(bar, "Match Case"));
            expect(menu.hidden).toBe(false);
        });

        it("a toggle inside should still toggle", () => {
            const bar = mount(true);
            const { button } = parts(bar);
            press(button);
            const row = option(bar, "Match Case");
            expect(row.getAttribute("aria-checked")).toBe("false");
            row.click();
            expect(row.getAttribute("aria-checked")).toBe("true");
        });

        // The accelerators VS Code's find widget binds reach the options
        // through the same path a press does, so they keep working after the
        // options changed shape. Mod+Alt rather than a bare Option on a Mac,
        // where Option types a dead character.
        it("the toggle accelerator should still reach an option in the menu", () => {
            const bar = mount(true);
            const row = option(bar, "Use Regular Expression");
            expect(row.getAttribute("aria-checked")).toBe("false");
            bar.dispatchEvent(new KeyboardEvent("keydown", {
                code: "KeyR", bubbles: true, cancelable: true,
                metaKey: true, altKey: true,
            }));
            expect(row.getAttribute("aria-checked")).toBe("true");
        });

        it("closing should leave no Escape layer behind", () => {
            const bar = mount(true);
            const { button } = parts(bar);
            press(button);
            press(document.getElementById("editor")!);
            // A leaked entry would swallow the next Escape the bar was owed.
            expect(closeTopmostLayer()).toBe(false);
        });
    });
});
